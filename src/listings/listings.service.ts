import { Injectable, NotFoundException, ForbiddenException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGuestListingDto, CreateListingDto, GuestContactDto, UpdateListingDto } from './listings.dto';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { S3Service } from '../utils/s3.service';
import { IntentionTag } from '@prisma/client';
import { NIGERIAN_STATES } from '../config/nigeria-locations';
import { LISTING_CATEGORIES } from '../config/listing-taxonomy';
import { MatchingJobsService } from '../matching/matching-jobs.service';
import { EmbeddingService } from '../matching/embedding.service';

const listingCardSelect = {
  id: true,
  title: true,
  slug: true,
  intentionTag: true,
  price: true,
  status: true,
  images: true,
  city: true,
  pairingKeyword: true,
  compatibilityAttributes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ListingSelect;

const listingSearchSelect = {
  ...listingCardSelect,
  description: true,
  category: true,
  pairingKeyword: true,
  isGuestListing: true,
} satisfies Prisma.ListingSelect;

type SearchListing = Prisma.ListingGetPayload<{ select: typeof listingSearchSelect }>;

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);
  private embeddedCorpusCache = { available: false, checkedAt: 0 };

  constructor(
    private prisma: PrismaService,
    private s3Service: S3Service,
    private matchingJobsService: MatchingJobsService,
    private embeddingService: EmbeddingService,
  ) {}

  private generateSlug(title: string): string {
    return (
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') +
      '-' +
      Date.now().toString(36)
    );
  }

  async create(userId: string, dto: CreateListingDto) {
    this.assertPublicListingIntent(dto.intentionTag);
    this.assertManagedImages(dto.images);
    this.assertCompatibilityAttributes(dto.compatibilityAttributes);
    const slug = this.generateSlug(dto.title);

    const data: Prisma.ListingCreateInput = {
      user: { connect: { id: userId } },
      title: dto.title,
      description: dto.description,
      slug,
      category: dto.category,
      condition: dto.condition,
      intentionTag: dto.intentionTag,
      pairingKeyword: dto.pairingKeyword,
      compatibilityAttributes: dto.compatibilityAttributes as Prisma.InputJsonValue,
      price: dto.price ? new Prisma.Decimal(dto.price) : null,
      city: dto.city,
      images: dto.images || [],
    };

    const listing = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.listing.create({
        data,
        include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
      });
      await this.matchingJobsService.enqueueListing(transaction, created.id, created.version, 'listing_created');
      return created;
    });
    await this.markListingImagesAttached(listing.images, listing.id);
    void this.notifyIndexNow(listing.slug);
    return this.withReadableImages(listing);
  }

  async createGuest(dto: CreateGuestListingDto) {
    this.assertPublicListingIntent(dto.intentionTag);
    this.assertManagedImages(dto.images);
    this.assertCompatibilityAttributes(dto.compatibilityAttributes);
    const guestContact = this.normalizeGuestContact(dto.guestContact);
    const slug = this.generateSlug(dto.title);
    const managementToken = randomBytes(32).toString('hex');
    const guestManageTokenHash = this.hashGuestManagementToken(managementToken);

    const listing = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.listing.create({
        data: {
        user: {
          create: {
            email: `guest-${randomUUID()}@guest.remnant.local`,
            name: 'Guest',
            emailVerified: false,
          },
        },
        title: dto.title,
        description: dto.description,
        slug,
        category: dto.category,
        condition: dto.condition,
        intentionTag: dto.intentionTag,
        pairingKeyword: dto.pairingKeyword,
        compatibilityAttributes: dto.compatibilityAttributes as Prisma.InputJsonValue,
        price: dto.price ? new Prisma.Decimal(dto.price) : null,
        city: dto.city,
        images: dto.images || [],
        isGuestListing: true,
        guestContact: {
          ...guestContact,
          manageTokenHash: guestManageTokenHash,
        } as Prisma.InputJsonValue,
        },
        include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
      });
      await this.matchingJobsService.enqueueListing(transaction, created.id, created.version, 'guest_listing_created');
      return created;
    });
    await this.markListingImagesAttached(listing.images, listing.id);
    void this.notifyIndexNow(listing.slug);
    return {
      ...(await this.withReadableImages(listing)),
      managementToken,
    };
  }

  async getGuestManagement(id: string, token?: string) {
    const listing = await this.getVerifiedGuestListing(id, token);
    return {
      id: listing.id,
      title: listing.title,
      slug: listing.slug,
      status: listing.status,
      image: (await this.s3Service.getReadableUrls(listing.images.slice(0, 1)))[0] ?? null,
    };
  }

  async updateGuestStatus(id: string, token: string | undefined, status: 'PAUSED' | 'COMPLETED') {
    const listing = await this.getVerifiedGuestListing(id, token);
    const updated = await this.prisma.listing.update({
      where: { id: listing.id },
      data: { status },
      select: { id: true, title: true, slug: true, status: true },
    });
    void this.notifyIndexNow(listing.slug);
    return {
      ...updated,
      message: status === 'COMPLETED'
        ? 'Listing marked as sold and removed from the marketplace'
        : 'Listing removed from the marketplace',
    };
  }

  async getGuestContact(id: string) {
    const listing = await this.prisma.listing.findFirst({
      where: { id, status: 'ACTIVE' },
      select: {
        isGuestListing: true,
        guestContact: true,
        compatibilityAttributes: true,
      },
    });
    if (!listing) throw new NotFoundException('Listing not found');

    const legacyGuestListing = Boolean(
      listing.compatibilityAttributes &&
      typeof listing.compatibilityAttributes === 'object' &&
      !Array.isArray(listing.compatibilityAttributes) &&
      (listing.compatibilityAttributes as Record<string, unknown>).guestListing,
    );
    if (!listing.isGuestListing && !legacyGuestListing) {
      throw new BadRequestException('This seller uses Remnant messages');
    }

    if (!listing.guestContact || typeof listing.guestContact !== 'object' || Array.isArray(listing.guestContact)) {
      throw new NotFoundException('This guest seller has not added contact details');
    }

    const contact = listing.guestContact as Record<string, unknown>;
    const methods = {
      phone: typeof contact.phone === 'string' ? contact.phone : undefined,
      email: typeof contact.email === 'string' ? contact.email : undefined,
      telegram: typeof contact.telegram === 'string' ? contact.telegram : undefined,
    };
    if (!methods.phone && !methods.email && !methods.telegram) {
      throw new NotFoundException('This guest seller has not added contact details');
    }

    return methods;
  }

  async findAll(filters?: {
    category?: string;
    intentionTag?: string;
    city?: string;
    search?: string;
    page?: number;
    limit?: number;
    cursor?: string;
    pagination?: string;
  }) {
    const page = Math.max(Number(filters?.page) || 1, 1);
    const limit = Math.min(Math.max(Number(filters?.limit) || 20, 1), 50);
    const cursorMode = filters?.pagination === 'cursor' || filters?.cursor !== undefined;
    const cursor = filters?.cursor ? this.decodeListingCursor(filters.cursor) : null;
    const skip = cursorMode ? undefined : (page - 1) * limit;

    const where: Prisma.ListingWhereInput = {
      status: 'ACTIVE',
      intentionTag: { not: 'WANTED' },
    };

    if (filters?.category) {
      if (!LISTING_CATEGORIES.includes(filters.category as (typeof LISTING_CATEGORIES)[number])) {
        throw new BadRequestException('Unknown listing category');
      }
      where.category = filters.category;
    }
    if (filters?.intentionTag) {
      if (!Object.values(IntentionTag).includes(filters.intentionTag as IntentionTag)) {
        throw new BadRequestException('Unknown listing intention');
      }
      this.assertPublicListingIntent(filters.intentionTag as IntentionTag);
      where.intentionTag = filters.intentionTag as IntentionTag;
    }
    if (filters?.city) {
      if (!NIGERIAN_STATES.includes(filters.city as (typeof NIGERIAN_STATES)[number])) {
        throw new BadRequestException('Unknown Nigerian state');
      }
      where.city = filters.city;
    }
    if (filters?.search) {
      const search = filters.search.trim().slice(0, 100);
      Object.assign(where, this.buildLexicalSearchWhere(search));
    }

    if (cursor) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const listings = await this.prisma.listing.findMany({
      where,
      ...(skip !== undefined ? { skip } : {}),
      take: cursorMode ? limit + 1 : limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: listingCardSelect,
    });
    const hasMore = cursorMode ? listings.length > limit : false;
    const pageListings = hasMore ? listings.slice(0, limit) : listings;
    const total = cursorMode ? undefined : await this.prisma.listing.count({ where });
    const last = pageListings.at(-1);

    return {
      listings: await Promise.all(pageListings.map((listing) => this.withReadableImages(listing, 1))),
      total,
      page,
      limit,
      totalPages: total === undefined ? undefined : Math.ceil(total / limit),
      hasMore,
      nextCursor: hasMore && last
        ? this.encodeListingCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    };
  }

  async getSitemapEntries() {
    const listings = await this.prisma.listing.findMany({
      where: { status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
      orderBy: { updatedAt: 'desc' },
      take: 50_000,
      select: {
        id: true,
        slug: true,
        images: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return listings.map(({ images, ...listing }) => ({
      ...listing,
      imageCount: images.length,
    }));
  }

  async findOne(id: string, trackView = true) {
    const listing = await this.prisma.listing.findFirst({
      where: { id, status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true, city: true, trustTier: true } },
      },
    });
    if (!listing) throw new NotFoundException(`Listing not found`);

    if (trackView) {
      await this.prisma.listing.update({
        where: { id },
        data: { viewCount: { increment: 1 } },
      });
    }

    return this.withReadableImages(listing);
  }

  async findBySlug(slug: string, trackView = true) {
    const listing = await this.prisma.listing.findFirst({
      where: { slug, status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true, city: true, trustTier: true } },
      },
    });
    if (!listing) throw new NotFoundException(`Listing not found`);

    if (trackView) {
      await this.prisma.listing.update({
        where: { id: listing.id },
        data: { viewCount: { increment: 1 } },
      });
    }

    return this.withReadableImages(listing);
  }

  async trackView(id: string, userAgent = '') {
    if (/(?:bot|crawler|spider|slurp|bingpreview|facebookexternalhit|whatsapp)/i.test(userAgent)) {
      return { tracked: false };
    }

    const result = await this.prisma.listing.updateMany({
      where: { id, status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
      data: { viewCount: { increment: 1 } },
    });
    if (result.count === 0) throw new NotFoundException('Listing not found');
    return { tracked: true };
  }

  async findByUser(userId: string) {
    const listings = await this.prisma.listing.findMany({
      where: {
        userId,
        status: { not: 'DELETED' },
        intentionTag: { not: 'WANTED' },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Promise.all(listings.map((listing) => this.withReadableImages(listing)));
  }

  async findSimilar(id: string, requestedLimit?: number) {
    const source = await this.prisma.listing.findFirst({
      where: { id, status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
    });
    if (!source) throw new NotFoundException('Listing not found');

    const limit = Math.min(Math.max(Number(requestedLimit) || 12, 1), 24);
    let rankedIds: string[] = [];

    try {
      const ranked = await this.prisma.$queryRaw<Array<{
        id: string;
        similarity: number | string;
        cityMatch: boolean;
        intentMatch: boolean;
      }>>`
        SELECT candidate.id,
          GREATEST(0, 1 - (candidate.embedding <=> source.embedding))::double precision AS similarity,
          (source.city IS NOT NULL AND candidate.city = source.city) AS "cityMatch",
          (candidate."intentionTag" = source."intentionTag") AS "intentMatch"
        FROM "Listing" candidate
        JOIN "Listing" source ON source.id = ${id}
        WHERE candidate.status = 'ACTIVE'
          AND candidate."intentionTag" <> 'WANTED'
          AND candidate.id <> source.id
          AND candidate.category = source.category
          AND source.embedding IS NOT NULL
          AND candidate.embedding IS NOT NULL
        ORDER BY candidate.embedding <=> source.embedding
        LIMIT ${Math.min(limit * 4, 96)}
      `;
      rankedIds = ranked
        .map((item) => ({
          id: item.id,
          score: Number(item.similarity) * 100 + (item.cityMatch ? 5 : 0) + (item.intentMatch ? 2 : 0),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((item) => item.id);
      if (rankedIds.length === 0) throw new Error('No embedded candidates');
    } catch (error) {
      this.logger.warn(`Vector ranking unavailable for listing ${id}; using text fallback.`);
      const candidates = await this.prisma.listing.findMany({
        where: {
          status: 'ACTIVE',
          intentionTag: { not: 'WANTED' },
          category: source.category,
          id: { not: id },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          title: true,
          description: true,
          pairingKeyword: true,
          city: true,
          intentionTag: true,
        },
      });
      rankedIds = candidates
        .map((candidate) => ({
          id: candidate.id,
          score:
            this.descriptionSimilarity(source, candidate) * 100 +
            (source.city && candidate.city === source.city ? 5 : 0) +
            (candidate.intentionTag === source.intentionTag ? 2 : 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((candidate) => candidate.id);
    }

    if (rankedIds.length === 0) return [];
    const listings = await this.prisma.listing.findMany({
      where: { id: { in: rankedIds }, status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
      select: listingCardSelect,
    });
    const byId = new Map(listings.map((listing) => [listing.id, listing]));
    const ordered = rankedIds.map((listingId) => byId.get(listingId)).filter((listing): listing is NonNullable<typeof listing> => Boolean(listing));
    return Promise.all(ordered.map((listing) => this.withReadableImages(listing, 1)));
  }

  async update(id: string, userId: string, dto: UpdateListingDto) {
    if (dto.intentionTag !== undefined) this.assertPublicListingIntent(dto.intentionTag);
    this.assertManagedImages(dto.images);
    this.assertCompatibilityAttributes(dto.compatibilityAttributes);
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException(`Listing not found`);
    if (listing.userId !== userId) throw new ForbiddenException('Not your listing');

    const data: Prisma.ListingUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.condition !== undefined) data.condition = dto.condition;
    if (dto.intentionTag !== undefined) data.intentionTag = dto.intentionTag;
    if (dto.pairingKeyword !== undefined) data.pairingKeyword = dto.pairingKeyword;
    if (dto.compatibilityAttributes !== undefined) {
      data.compatibilityAttributes = dto.compatibilityAttributes as Prisma.InputJsonValue;
    }
    if (dto.price !== undefined) data.price = dto.price ? new Prisma.Decimal(dto.price) : null;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.images !== undefined) data.images = dto.images;

    data.version = { increment: 1 };
    const updated = await this.prisma.$transaction(async (transaction) => {
      const row = await transaction.listing.update({
        where: { id },
        data,
        include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
      });
      await this.matchingJobsService.enqueueListing(transaction, row.id, row.version, 'listing_updated');
      return row;
    });
    if (dto.images !== undefined) {
      const removedImages = listing.images.filter((image) => !dto.images?.includes(image));
      await Promise.all([
        this.markListingImagesAttached(updated.images, updated.id),
        this.markListingImagesOrphaned(removedImages, updated.id),
      ]);
    }
    void this.notifyIndexNow(updated.slug);
    return this.withReadableImages(updated);
  }

  async remove(id: string, userId: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException(`Listing not found`);
    if (listing.userId !== userId) throw new ForbiddenException('Not your listing');

    await this.prisma.listing.update({
      where: { id },
      data: { status: 'DELETED' },
    });
    void this.notifyIndexNow(listing.slug);
    return { message: 'Listing deleted' };
  }

  async saveListing(userId: string, listingId: string) {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
    });
    if (!listing) throw new NotFoundException('Listing not found');

    return this.prisma.savedListing.upsert({
      where: { userId_listingId: { userId, listingId } },
      create: { userId, listingId },
      update: {},
    });
  }

  async unsaveListing(userId: string, listingId: string) {
    await this.prisma.savedListing.deleteMany({
      where: { userId, listingId },
    });
    return { message: 'Listing unsaved' };
  }

  async getSavedListings(userId: string) {
    const saved = await this.prisma.savedListing.findMany({
      where: {
        userId,
        listing: { status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
      },
      include: {
        listing: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Promise.all(saved.map((item) => this.withReadableImages(item.listing)));
  }

  async semanticSearch(params: {
    query?: string;
    category?: string;
    city?: string;
    intent?: string;
    limit?: number;
    page?: number;
  }) {
    const query = params.query?.trim();
    const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);
    const page = Math.min(Math.max(Number(params.page) || 1, 1), 20);

    if (params.category && !LISTING_CATEGORIES.includes(params.category as (typeof LISTING_CATEGORIES)[number])) {
      throw new BadRequestException('Unknown listing category');
    }
    if (params.city && !NIGERIAN_STATES.includes(params.city as (typeof NIGERIAN_STATES)[number])) {
      throw new BadRequestException('Unknown Nigerian state');
    }
    if (params.intent && !Object.values(IntentionTag).includes(params.intent as IntentionTag)) {
      throw new BadRequestException('Unknown listing intention');
    }
    if (params.intent) this.assertPublicListingIntent(params.intent as IntentionTag);

    if (!query) {
      const fallback = await this.findAll({
        category: params.category,
        intentionTag: params.intent,
        city: params.city,
        page,
        limit,
      });
      return fallback.listings;
    }

    const baseWhere: Prisma.ListingWhereInput = {
      status: 'ACTIVE',
      ...(params.category ? { category: params.category } : {}),
      ...(params.city ? { city: params.city } : {}),
      ...(params.intent
        ? { intentionTag: params.intent as IntentionTag }
        : { intentionTag: { not: 'WANTED' as IntentionTag } }),
    };
    const candidateLimit = Math.min(Math.max(limit * page * 6, 60), 500);
    const lexicalCandidates = await this.findLexicalCandidates(query, baseWhere, candidateLimit);

    const semanticRelevance = new Map<string, number>();
    const minimumLexicalResults = Math.max(
      1,
      Number(process.env.SEMANTIC_SEARCH_MIN_LEXICAL_RESULTS || 6),
    );
    const semanticEnabled =
      process.env.SEMANTIC_SEARCH_ENABLED !== 'false' &&
      this.embeddingService.isConfigured() &&
      lexicalCandidates.length < minimumLexicalResults &&
      await this.hasEmbeddedCorpus();
    if (semanticEnabled) {
      try {
        const queryEmbedding = await this.embeddingService.generateQueryEmbedding(query);
        const vector = JSON.stringify(queryEmbedding);
        const categoryFilter = params.category ? Prisma.sql`AND l.category = ${params.category}` : Prisma.empty;
        const cityFilter = params.city ? Prisma.sql`AND l.city = ${params.city}` : Prisma.empty;
        const intentFilter = params.intent
          ? Prisma.sql`AND l."intentionTag"::text = ${params.intent}`
          : Prisma.empty;
        const semanticRows = await this.prisma.$queryRaw<Array<{ id: string; relevance: number | string }>>`
          SELECT l.id, (1 - (l.embedding <=> ${vector}::vector)) AS relevance
          FROM "Listing" l
          WHERE l.status = 'ACTIVE'
            AND l."intentionTag" <> 'WANTED'
            AND l.embedding IS NOT NULL
            ${categoryFilter}
            ${cityFilter}
            ${intentFilter}
          ORDER BY l.embedding <=> ${vector}::vector
          LIMIT ${candidateLimit}
        `;

        for (const row of semanticRows) {
          const relevance = Number(row.relevance);
          if (Number.isFinite(relevance) && relevance >= 0.25) {
            semanticRelevance.set(row.id, relevance);
          }
        }
      } catch (error) {
        this.logger.warn(`Semantic search failed; returning exact text matches instead. ${this.errorMessage(error)}`);
      }
    }

    const candidatesById = new Map<string, SearchListing>(
      lexicalCandidates.map((listing) => [listing.id, listing]),
    );
    const missingSemanticIds = [...semanticRelevance.keys()].filter((id) => !candidatesById.has(id));
    if (missingSemanticIds.length > 0) {
      const semanticCandidates = await this.prisma.listing.findMany({
        where: { ...baseWhere, id: { in: missingSemanticIds } },
        take: candidateLimit,
        select: listingSearchSelect,
      });
      semanticCandidates.forEach((listing) => candidatesById.set(listing.id, listing));
    }

    const tokens = this.getSearchTokens(query);
    const ranked = [...candidatesById.values()]
      .map((listing) => ({
        listing,
        score: this.scoreSearchResult(listing, query, tokens, semanticRelevance.get(listing.id) ?? 0),
      }))
      .sort((left, right) =>
        right.score - left.score || right.listing.createdAt.getTime() - left.listing.createdAt.getTime(),
      )
      .slice((page - 1) * limit, page * limit);

    return Promise.all(
      ranked.map(async ({ listing, score }) => ({
        ...(await this.withReadableImages(listing, 1)),
        relevance: this.roundSearchScore(score),
      })),
    );
  }

  private async findLexicalCandidates(
    query: string,
    baseWhere: Prisma.ListingWhereInput,
    limit: number,
  ): Promise<SearchListing[]> {
    const category = typeof baseWhere.category === 'string' ? baseWhere.category : undefined;
    const city = typeof baseWhere.city === 'string' ? baseWhere.city : undefined;
    const intent = typeof baseWhere.intentionTag === 'string' ? baseWhere.intentionTag : undefined;
    const categoryFilter = category ? Prisma.sql`AND l.category = ${category}` : Prisma.empty;
    const cityFilter = city ? Prisma.sql`AND l.city = ${city}` : Prisma.empty;
    const intentFilter = intent
      ? Prisma.sql`AND l."intentionTag"::text = ${intent}`
      : Prisma.sql`AND l."intentionTag" <> 'WANTED'`;

    try {
      return await this.prisma.$queryRaw<SearchListing[]>(Prisma.sql`
        SELECT
          l.id, l.title, l.slug, l."intentionTag", l.price, l.status,
          l.images, l.city, l."pairingKeyword", l."compatibilityAttributes",
          l."createdAt", l."updatedAt", l.description, l.category,
          l."isGuestListing"
        FROM "Listing" l
        WHERE l.status = 'ACTIVE'
          ${intentFilter}
          ${categoryFilter}
          ${cityFilter}
          AND (
            l."searchDocument" @@ websearch_to_tsquery('simple', ${query})
            OR similarity(
              lower(
                coalesce(l.title, '') || ' ' ||
                coalesce(l."pairingKeyword", '') || ' ' ||
                coalesce(l.category, '') || ' ' ||
                coalesce(l.city, '') || ' ' ||
                coalesce(l.description, '')
              ),
              lower(${query})
            ) >= 0.18
            OR lower(l.title) % lower(${query})
            OR lower(coalesce(l."pairingKeyword", '')) % lower(${query})
          )
        ORDER BY
          (
            ts_rank_cd(l."searchDocument", websearch_to_tsquery('simple', ${query})) * 2
            + GREATEST(
                similarity(lower(l.title), lower(${query})),
                similarity(lower(coalesce(l."pairingKeyword", '')), lower(${query})),
                similarity(lower(l.description), lower(${query})) * 0.6
              )
          ) DESC,
          l."createdAt" DESC,
          l.id DESC
        LIMIT ${limit}
      `);
    } catch (error) {
      this.logger.warn(`Indexed text search unavailable; using compatibility fallback. ${this.errorMessage(error)}`);
      return this.prisma.listing.findMany({
        where: { ...baseWhere, ...this.buildLexicalSearchWhere(query) },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: listingSearchSelect,
      });
    }
  }

  private async hasEmbeddedCorpus() {
    if (this.embeddedCorpusCache.checkedAt > Date.now() - 60_000) {
      return this.embeddedCorpusCache.available;
    }
    const rows = await this.prisma.$queryRaw<Array<{ available: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM "Listing"
        WHERE status = 'ACTIVE' AND "intentionTag" <> 'WANTED' AND embedding IS NOT NULL
      ) AS available
    `;
    this.embeddedCorpusCache = {
      available: Boolean(rows[0]?.available),
      checkedAt: Date.now(),
    };
    return this.embeddedCorpusCache.available;
  }

  private async withReadableImages<T extends { images: string[] }>(listing: T, maxImages?: number): Promise<T> {
    const images = maxImages ? listing.images.slice(0, maxImages) : listing.images;
    return {
      ...listing,
      guestContact: undefined,
      images: await this.s3Service.getReadableUrls(images ?? []),
    } as T;
  }

  private normalizeGuestContact(contact: GuestContactDto) {
    const phone = contact.phone?.trim();
    const email = contact.email?.trim().toLowerCase();
    const telegram = contact.telegram?.trim();

    if (phone) {
      const digitCount = phone.replace(/\D/g, '').length;
      if (digitCount < 7 || digitCount > 15) {
        throw new BadRequestException('Enter a valid phone number with 7 to 15 digits');
      }
    }

    if (telegram) {
      let url: URL;
      try {
        url = new URL(telegram);
      } catch {
        throw new BadRequestException('Enter a valid Telegram link');
      }
      const host = url.hostname.toLowerCase();
      const username = url.pathname.replace(/^\//, '').replace(/\/$/, '');
      if (url.protocol !== 'https:' || !['t.me', 'www.t.me'].includes(host) || !/^[a-zA-Z0-9_]{5,32}$/.test(username)) {
        throw new BadRequestException('Use a Telegram profile link such as https://t.me/username');
      }
    }

    if (!phone && !email && !telegram) {
      throw new BadRequestException('Add a phone number, Telegram link, or email so buyers can reach you');
    }

    return {
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
      ...(telegram ? { telegram } : {}),
    };
  }

  private async notifyIndexNow(slug: string) {
    const key = process.env.INDEXNOW_KEY?.trim();
    if (!key) return;

    const url = `https://remnantmarket.co/marketplace/${encodeURIComponent(slug)}`;
    try {
      const response = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host: 'remnantmarket.co',
          key,
          keyLocation: 'https://remnantmarket.co/indexnow-key.txt',
          urlList: [url],
        }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok && response.status !== 202) {
        this.logger.warn(`IndexNow rejected ${url} with status ${response.status}.`);
      }
    } catch (error) {
      this.logger.warn(`IndexNow notification failed for ${url}.`);
    }
  }

  private descriptionSimilarity(
    first: { title: string; description: string; pairingKeyword: string | null },
    second: { title: string; description: string; pairingKeyword: string | null },
  ) {
    const tokens = (value: string) =>
      new Set(
        value
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((token) => token.length > 2),
      );
    const firstTokens = tokens(`${first.title} ${first.description} ${first.pairingKeyword ?? ''}`);
    const secondTokens = tokens(`${second.title} ${second.description} ${second.pairingKeyword ?? ''}`);
    if (firstTokens.size === 0 || secondTokens.size === 0) return 0;
    const overlap = [...firstTokens].filter((token) => secondTokens.has(token)).length;
    return overlap / Math.max(firstTokens.size, secondTokens.size);
  }

  private assertManagedImages(images?: string[]) {
    if (images?.some((url) => !this.s3Service.getObjectKey(url))) {
      throw new BadRequestException('Listing images must be uploaded through Remnant.');
    }
  }

  private getSearchTokens(query: string) {
    return [...new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)),
    )].slice(0, 12);
  }

  private assertCompatibilityAttributes(value?: Record<string, unknown>) {
    if (value === undefined) return;
    const serialized = JSON.stringify(value);
    if (serialized.length > 4_000) {
      throw new BadRequestException('Compatibility details are too large');
    }
    const visit = (item: unknown, depth: number) => {
      if (depth > 2) throw new BadRequestException('Compatibility details are too deeply nested');
      if (Array.isArray(item)) {
        if (item.length > 20) throw new BadRequestException('Compatibility detail lists are too long');
        item.forEach((entry) => visit(entry, depth + 1));
        return;
      }
      if (item && typeof item === 'object') {
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length > 30) throw new BadRequestException('Too many compatibility details');
        entries.forEach(([key, entry]) => {
          if (key.length > 60) throw new BadRequestException('Compatibility detail keys are too long');
          visit(entry, depth + 1);
        });
        return;
      }
      if (typeof item === 'string' && item.length > 200) {
        throw new BadRequestException('A compatibility detail is too long');
      }
    };
    visit(value, 0);
  }

  private encodeListingCursor(cursor: { createdAt: string; id: string }) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeListingCursor(value: string) {
    try {
      if (value.length > 512) throw new Error('Invalid cursor');
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
        createdAt?: string;
        id?: string;
      };
      if (
        !parsed.id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id) ||
        !parsed.createdAt ||
        Number.isNaN(new Date(parsed.createdAt).getTime())
      ) {
        throw new Error('Invalid cursor');
      }
      return { id: parsed.id, createdAt: parsed.createdAt };
    } catch {
      throw new BadRequestException('Invalid listing cursor');
    }
  }

  private hashGuestManagementToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async getVerifiedGuestListing(id: string, token?: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        images: true,
        isGuestListing: true,
        guestContact: true,
      },
    });
    const guestContact = listing?.guestContact;
    const guestManageTokenHash = guestContact
      && typeof guestContact === 'object'
      && !Array.isArray(guestContact)
      && typeof (guestContact as Record<string, unknown>).manageTokenHash === 'string'
        ? (guestContact as Record<string, string>).manageTokenHash
        : undefined;
    if (!listing || !listing.isGuestListing || !guestManageTokenHash) {
      throw new NotFoundException('Guest listing not found');
    }
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      throw new ForbiddenException('A valid guest listing management key is required');
    }

    const provided = Buffer.from(this.hashGuestManagementToken(token), 'hex');
    const stored = Buffer.from(guestManageTokenHash, 'hex');
    if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
      throw new ForbiddenException('This guest listing management key is invalid');
    }
    return listing;
  }

  private buildLexicalSearchWhere(query: string): Prisma.ListingWhereInput {
    const tokens = this.getSearchTokens(query);
    const searchableFields = (term: string): Prisma.ListingWhereInput[] => [
      { title: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
      { pairingKeyword: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { city: { contains: term, mode: 'insensitive' } },
    ];

    if (tokens.length === 0) {
      return { OR: searchableFields(query.trim().slice(0, 100)) };
    }

    return {
      AND: tokens.map((token) => ({ OR: searchableFields(token) })),
    };
  }

  private scoreSearchResult(listing: SearchListing, query: string, tokens: string[], semanticScore: number) {
    const phrase = query.trim().toLowerCase();
    const title = listing.title.toLowerCase();
    const description = listing.description.toLowerCase();
    const pairingKeyword = listing.pairingKeyword?.toLowerCase() ?? '';
    const category = listing.category.toLowerCase();
    const city = listing.city?.toLowerCase() ?? '';
    let score = Math.max(0, semanticScore) * 40;

    if (title === phrase) score += 110;
    else if (title.includes(phrase)) score += 70;
    if (pairingKeyword.includes(phrase)) score += 60;
    if (description.includes(phrase)) score += 35;
    if (city === phrase) score += 55;
    else if (city.includes(phrase)) score += 35;
    if (category.includes(phrase)) score += 25;

    for (const token of tokens) {
      if (title.includes(token)) score += 16;
      if (pairingKeyword.includes(token)) score += 14;
      if (description.includes(token)) score += 5;
      if (city.includes(token)) score += 12;
      if (category.includes(token)) score += 8;
    }

    const mentionedState = NIGERIAN_STATES.find((state) => phrase.includes(state.toLowerCase()));
    if (mentionedState && city === mentionedState.toLowerCase()) score += 50;
    return score;
  }

  private roundSearchScore(score: number) {
    return Math.round(Math.min(1, score / 100) * 1000) / 1000;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'Unknown error';
  }

  private async markListingImagesAttached(images: string[], listingId: string) {
    try {
      await this.s3Service.markFilesAttached(images);
    } catch (error) {
      this.logger.warn(`Listing ${listingId} was saved but its image lifecycle tags could not be finalized: ${this.errorMessage(error)}`);
    }
  }

  private async markListingImagesOrphaned(images: string[], listingId: string) {
    if (images.length === 0) return;
    try {
      const references = await this.prisma.listing.findMany({
        where: { id: { not: listingId }, images: { hasSome: images } },
        select: { images: true },
      });
      const stillReferenced = new Set(references.flatMap((listing) => listing.images));
      const unreferenced = images.filter((image) => !stillReferenced.has(image));
      await this.s3Service.markFilesOrphaned(unreferenced);
    } catch (error) {
      this.logger.warn(`Listing ${listingId} image cleanup tags could not be updated: ${this.errorMessage(error)}`);
    }
  }

  private assertPublicListingIntent(intent: IntentionTag) {
    if (intent === 'WANTED') {
      throw new BadRequestException('Pair alerts are private. Create this from your Pair Alerts page.');
    }
  }
}
