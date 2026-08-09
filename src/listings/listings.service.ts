import { Injectable, NotFoundException, ForbiddenException, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateGuestListingDto,
  CreateListingDto,
  GuestContactMethod,
  UpdateGuestListingContactDto,
  UpdateListingDto,
} from './listings.dto';
import { ListingStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { S3Service } from '../utils/s3.service';
import { IntentionTag } from '@prisma/client';
import { NIGERIAN_STATES } from '../config/nigeria-locations';
import { LISTING_CATEGORIES } from '../config/listing-taxonomy';
import { MatchingJobsService } from '../matching/matching-jobs.service';
import { EmbeddingService } from '../matching/embedding.service';
import { GuestAccessService } from '../auth/guest-access.service';

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
    private guestAccessService: GuestAccessService,
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
    this.assertPrice(dto.intentionTag, dto.price);
    const existing = await this.findIdempotentListing(userId, dto.clientRequestId);
    if (existing) return this.withReadableImages(existing);
    const slug = this.generateSlug(dto.title);
    const listingId = randomUUID();

    const data: Prisma.ListingCreateInput = {
      id: listingId,
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
      images: dto.images,
      clientRequestId: dto.clientRequestId,
      expiresAt: this.listingExpiryDate(),
    };

    try {
      const listing = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.listing.create({
          data,
          include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
        });
        await this.attachUploads(transaction, userId, dto.uploadIds, dto.images, listingId);
        await this.matchingJobsService.enqueueListing(transaction, created.id, created.version, 'listing_created');
        return created;
      });
      void this.finalizeImageTags(listing.images, listing.id);
      void this.notifyIndexNow(listing.slug);
      return this.withReadableImages(listing);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.findIdempotentListing(userId, dto.clientRequestId);
        if (duplicate) return this.withReadableImages(duplicate);
      }
      throw error;
    }
  }

  async createGuest(dto: CreateGuestListingDto, token?: string) {
    const guest = this.guestAccessService.verifyIdentityToken(token);
    this.assertPublicListingIntent(dto.intentionTag);
    this.assertManagedImages(dto.images);
    this.assertCompatibilityAttributes(dto.compatibilityAttributes);
    this.assertPrice(dto.intentionTag, dto.price);
    const guestContact = this.normalizeGuestContact(dto.contactMethod, dto.contactValue);
    const existing = await this.findIdempotentListing(guest.userId, dto.clientRequestId);
    if (existing) {
      return { ...(await this.withReadableImages(existing)), managementToken: token };
    }
    const slug = this.generateSlug(dto.title);
    const listingId = randomUUID();

    try {
      const listing = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.listing.create({
          data: {
            id: listingId,
            user: { connect: { id: guest.userId } },
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
            images: dto.images,
            isGuestListing: true,
            guestContact,
            clientRequestId: dto.clientRequestId,
            expiresAt: this.listingExpiryDate(),
          },
          include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
        });
        await this.attachUploads(transaction, guest.userId, dto.uploadIds, dto.images, listingId);
        await this.matchingJobsService.enqueueListing(transaction, created.id, created.version, 'guest_listing_created');
        return created;
      });
      void this.finalizeImageTags(listing.images, listing.id);
      void this.notifyIndexNow(listing.slug);
      return { ...(await this.withReadableImages(listing)), managementToken: token };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.findIdempotentListing(guest.userId, dto.clientRequestId);
        if (duplicate) return { ...(await this.withReadableImages(duplicate)), managementToken: token };
      }
      throw error;
    }
  }

  async getGuestManagement(id: string, token?: string) {
    const listing = await this.getVerifiedGuestListing(id, token);
    return {
      id: listing.id,
      title: listing.title,
      slug: listing.slug,
      status: listing.status,
      version: listing.version,
      contact: this.publicGuestContact(listing.guestContact),
      image: (await this.s3Service.getReadableUrls(listing.images.slice(0, 1)))[0] ?? null,
    };
  }


  async updateGuestContact(
    id: string,
    token: string | undefined,
    dto: UpdateGuestListingContactDto,
  ) {
    const listing = await this.getVerifiedGuestListing(id, token);
    if (listing.version !== dto.version) {
      throw new ConflictException('This listing changed. Refresh before updating it.');
    }
    const contact = this.normalizeGuestContact(dto.contactMethod, dto.contactValue);
    const changed = await this.prisma.listing.updateMany({
      where: { id: listing.id, version: dto.version },
      data: { guestContact: contact, version: { increment: 1 } },
    });
    if (changed.count !== 1) {
      throw new ConflictException('This listing changed. Refresh before updating it.');
    }
    return {
      contact,
      version: dto.version + 1,
      message: 'Contact details updated',
    };
  }

  async updateGuestStatus(
    id: string,
    token: string | undefined,
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED',
    version: number,
  ) {
    const listing = await this.getVerifiedGuestListing(id, token);
    if (listing.version !== version) {
      throw new ConflictException('This listing changed. Refresh before updating it.');
    }
    if (status === 'ACTIVE' && !this.publicGuestContact(listing.guestContact)) {
      throw new BadRequestException('Add a public contact before publishing this listing');
    }
    this.assertStatusTransition(listing.status, status);
    const changed = await this.prisma.listing.updateMany({
      where: { id: listing.id, version },
      data: {
        status,
        version: { increment: 1 },
        ...(status === 'ACTIVE' ? { expiresAt: this.listingExpiryDate() } : {}),
      },
    });
    if (changed.count !== 1) throw new ConflictException('This listing changed. Refresh before updating it.');
    const updated = await this.prisma.listing.findUnique({
      where: { id: listing.id },
      select: { id: true, title: true, slug: true, status: true, version: true },
    });
    if (!updated) throw new NotFoundException('Guest listing not found');
    void this.notifyIndexNow(listing.slug);
    return {
      ...updated,
      message: status === 'COMPLETED'
        ? 'Listing marked as sold and removed from the marketplace'
        : status === 'ACTIVE'
          ? 'Listing published in the marketplace'
          : 'Listing removed from the marketplace',
    };
  }

  async expireListings() {
    const result = await this.prisma.listing.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED', version: { increment: 1 } },
    });
    return { expired: result.count };
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
    } catch {
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
    if (listing.version !== dto.version) {
      throw new ConflictException('This listing changed in another session. Refresh before saving again.');
    }
    this.assertStatusTransition(listing.status, dto.status);
    if (listing.status === 'COMPLETED' && Object.keys(dto).some((key) => !['version', 'status'].includes(key))) {
      throw new ConflictException('Completed listings cannot be edited');
    }
    if ((dto.images === undefined) !== (dto.uploadIds === undefined)) {
      throw new BadRequestException('Images and upload references must be submitted together');
    }

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
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.status === 'ACTIVE') data.expiresAt = this.listingExpiryDate();

    data.version = { increment: 1 };
    const updated = await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.listing.updateMany({
        where: { id, userId, version: dto.version },
        data,
      });
      if (changed.count !== 1) {
        throw new ConflictException('This listing changed in another session. Refresh before saving again.');
      }

      if (dto.images !== undefined && dto.uploadIds !== undefined) {
        const newImages = dto.images.filter((image) => !listing.images.includes(image));
        if (newImages.length > 0 || dto.uploadIds.length > 0) {
          await this.attachUploads(transaction, userId, dto.uploadIds, newImages, id);
        }
        const removedKeys = listing.images
          .filter((image) => !dto.images!.includes(image))
          .map((image) => this.s3Service.getObjectKey(image))
          .filter((key): key is string => Boolean(key));
        if (removedKeys.length > 0) {
          await transaction.upload.updateMany({
            where: { listingId: id, s3Key: { in: removedKeys }, status: 'ATTACHED' },
            data: { listingId: null, status: 'PENDING', attachedAt: null },
          });
        }
      }

      const row = await transaction.listing.findUnique({
        where: { id },
        include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
      });
      if (!row) throw new NotFoundException('Listing not found');
      await this.matchingJobsService.enqueueListing(transaction, row.id, row.version, 'listing_updated');
      return row;
    });
    if (dto.images !== undefined) {
      const removedImages = listing.images.filter((image) => !dto.images?.includes(image));
      await Promise.all([
        this.finalizeImageTags(updated.images, updated.id),
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

    await this.prisma.$transaction([
      this.prisma.listing.update({
        where: { id },
        data: { status: 'DELETED', version: { increment: 1 }, images: [] },
      }),
      this.prisma.upload.updateMany({
        where: { listingId: id, status: 'ATTACHED' },
        data: { listingId: null, status: 'PENDING', attachedAt: null },
      }),
    ]);
    void this.markListingImagesOrphaned(listing.images, listing.id);
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
      guestContact: this.publicGuestContact((listing as T & { guestContact?: unknown }).guestContact),
      images: await this.s3Service.getReadableUrls(images ?? []),
    } as T;
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
    } catch {
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
    if (!images || images.length === 0) {
      throw new BadRequestException('Add at least one listing image');
    }
    if (images?.some((url) => !this.s3Service.getObjectKey(url))) {
      throw new BadRequestException('Listing images must be uploaded through Remnant.');
    }
  }


  private publicGuestContact(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const contact = value as Record<string, unknown>;
    if (
      !['WHATSAPP', 'EMAIL', 'TELEGRAM'].includes(String(contact.method)) ||
      typeof contact.value !== 'string'
    ) {
      return undefined;
    }
    return { method: contact.method as GuestContactMethod, value: contact.value };
  }

  private normalizeGuestContact(method: GuestContactMethod, rawValue: string) {
    const value = rawValue.trim();
    if (method === 'EMAIL') {
      const email = value.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw new BadRequestException('Enter a valid email address');
      }
      return { method, value: email };
    }

    if (method === 'WHATSAPP') {
      let phone = value.replace(/[^\d+]/g, '');
      if (phone.startsWith('+')) phone = phone.slice(1);
      if (phone.startsWith('0')) phone = `234${phone.slice(1)}`;
      if (!/^\d{10,15}$/.test(phone)) {
        throw new BadRequestException('Enter a valid WhatsApp number with country code');
      }
      return { method, value: phone };
    }

    const username = value
      .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, '')
      .replace(/^@/, '')
      .replace(/\/$/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
      throw new BadRequestException('Enter a valid Telegram username');
    }
    return { method, value: `@${username}` };
  }

  private assertPrice(intent: IntentionTag, price?: string) {
    if (intent !== 'SELL') return;
    if (!price) throw new BadRequestException('A selling price is required');
    const amount = new Prisma.Decimal(price);
    if (amount.lte(0) || amount.gt('999999999.99')) {
      throw new BadRequestException('Price must be greater than zero and no more than 999,999,999.99');
    }
  }

  private assertStatusTransition(current: ListingStatus, next?: 'ACTIVE' | 'PAUSED' | 'COMPLETED') {
    if (!next || next === current) return;
    const allowed: Partial<Record<ListingStatus, ListingStatus[]>> = {
      ACTIVE: ['PAUSED', 'COMPLETED'],
      PAUSED: ['ACTIVE', 'COMPLETED'],
      COMPLETED: [],
      EXPIRED: ['ACTIVE'],
      FLAGGED: [],
      DELETED: [],
    };
    if (!(allowed[current] ?? []).includes(next)) {
      throw new ConflictException(`Listing cannot move from ${current} to ${next}`);
    }
  }

  private listingExpiryDate() {
    const configuredDays = Number(process.env.LISTING_EXPIRY_DAYS ?? 90);
    const days = Number.isFinite(configuredDays) ? Math.min(Math.max(configuredDays, 7), 365) : 90;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  private async findIdempotentListing(userId: string, clientRequestId: string) {
    return this.prisma.listing.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
      include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
    });
  }

  private async attachUploads(
    transaction: Prisma.TransactionClient,
    ownerId: string,
    uploadIds: string[],
    images: string[],
    listingId: string,
  ) {
    const uniqueIds = [...new Set(uploadIds)];
    const uniqueImageKeys = [...new Set(images.map((image) => this.s3Service.getObjectKey(image)))];
    if (
      uniqueIds.length !== uploadIds.length ||
      uniqueImageKeys.some((key) => !key) ||
      uniqueImageKeys.length !== images.length ||
      uniqueIds.length !== uniqueImageKeys.length
    ) {
      throw new BadRequestException('Each listing image must reference one unique upload');
    }

    const uploads = await transaction.upload.findMany({
      where: { id: { in: uniqueIds }, ownerId, status: 'PENDING', listingId: null },
      select: { id: true, s3Key: true },
    });
    const expectedKeys = new Set(uniqueImageKeys as string[]);
    if (uploads.length !== uniqueIds.length || uploads.some((upload) => !expectedKeys.has(upload.s3Key))) {
      throw new ForbiddenException('An upload is unavailable or does not belong to this publisher');
    }

    const attached = await transaction.upload.updateMany({
      where: { id: { in: uniqueIds }, ownerId, status: 'PENDING', listingId: null },
      data: { status: 'ATTACHED', listingId, attachedAt: new Date() },
    });
    if (attached.count !== uniqueIds.length) {
      throw new ConflictException('One or more uploads were already attached; refresh and try again');
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
        version: true,
        images: true,
        userId: true,
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
    if (!listing || !listing.isGuestListing) {
      throw new NotFoundException('Guest listing not found');
    }

    try {
      const guest = this.guestAccessService.verifyIdentityToken(token);
      if (guest.userId === listing.userId) return listing;
    } catch {
      // Legacy per-listing management keys remain valid during migration.
    }

    if (!guestManageTokenHash || !token || !/^[a-f0-9]{64}$/i.test(token)) {
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

  private async finalizeImageTags(images: string[], listingId: string) {
    try {
      await this.s3Service.markFilesAttached(images);
    } catch (error) {
      this.logger.warn(`Listing ${listingId} is safely attached in the upload registry, but its optional S3 tag update will need reconciliation: ${this.errorMessage(error)}`);
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
