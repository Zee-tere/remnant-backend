import { Injectable, NotFoundException, ForbiddenException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGuestListingDto, CreateListingDto, GuestContactDto, UpdateListingDto } from './listings.dto';
import { Prisma } from '@prisma/client';
import { MatchingService } from '../matching/matching.service';
import { EmbeddingService } from '../matching/embedding.service';
import { randomUUID } from 'crypto';
import { S3Service } from '../utils/s3.service';
import { IntentionTag } from '@prisma/client';
import { NIGERIAN_STATES } from '../config/nigeria-locations';
import { LISTING_CATEGORIES } from '../config/listing-taxonomy';

const listingCardSelect = {
  id: true,
  title: true,
  slug: true,
  intentionTag: true,
  price: true,
  status: true,
  images: true,
  city: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ListingSelect;

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    private prisma: PrismaService,
    private matchingService: MatchingService,
    private embeddingService: EmbeddingService,
    private s3Service: S3Service,
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
    this.assertManagedImages(dto.images);
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

    const listing = await this.prisma.listing.create({
      data,
      include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
    });

    this.scheduleListingMatching(listing.id, 'listing_created');
    void this.notifyIndexNow(listing.slug);
    return this.withReadableImages(listing);
  }

  async createGuest(dto: CreateGuestListingDto) {
    this.assertManagedImages(dto.images);
    const guestContact = this.normalizeGuestContact(dto.guestContact);
    const slug = this.generateSlug(dto.title);

    const listing = await this.prisma.listing.create({
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
        guestContact: guestContact as Prisma.InputJsonValue,
      },
      include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
    });

    this.scheduleListingMatching(listing.id, 'guest_listing_created');
    void this.notifyIndexNow(listing.slug);
    return this.withReadableImages(listing);
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
  }) {
    const page = Math.max(Number(filters?.page) || 1, 1);
    const limit = Math.min(Math.max(Number(filters?.limit) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const where: Prisma.ListingWhereInput = {
      status: 'ACTIVE',
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
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [listings, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: listingCardSelect,
      }),
      this.prisma.listing.count({ where }),
    ]);

    return {
      listings: await Promise.all(listings.map((listing) => this.withReadableImages(listing, 1))),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getSitemapEntries() {
    const listings = await this.prisma.listing.findMany({
      where: { status: 'ACTIVE' },
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
    const listing = await this.prisma.listing.findUnique({
      where: { id },
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
    const listing = await this.prisma.listing.findUnique({
      where: { slug },
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
      where: { id, status: 'ACTIVE' },
      data: { viewCount: { increment: 1 } },
    });
    if (result.count === 0) throw new NotFoundException('Listing not found');
    return { tracked: true };
  }

  async findByUser(userId: string) {
    const listings = await this.prisma.listing.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(listings.map((listing) => this.withReadableImages(listing)));
  }

  async findSimilar(id: string, requestedLimit?: number) {
    const source = await this.prisma.listing.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Listing not found');

    const limit = Math.min(Math.max(Number(requestedLimit) || 12, 1), 24);
    let rankedIds: string[] = [];

    try {
      const ranked = await this.prisma.$queryRaw<Array<{ id: string; score: number | string }>>`
        SELECT candidate.id,
          (
            CASE
              WHEN source.city IS NOT NULL AND candidate.city = source.city THEN 1000
              ELSE 0
            END
            + CASE
                WHEN candidate."intentionTag" = source."intentionTag" THEN 100
                ELSE 0
              END
            + CASE
                WHEN source.embedding IS NOT NULL AND candidate.embedding IS NOT NULL
                  THEN GREATEST(0, 1 - (candidate.embedding <=> source.embedding)) * 10
                ELSE 0
              END
          )::double precision AS score
        FROM "Listing" candidate
        JOIN "Listing" source ON source.id = ${id}
        WHERE candidate.status = 'ACTIVE'
          AND candidate.id <> source.id
        ORDER BY score DESC, candidate."createdAt" DESC
        LIMIT ${limit}
      `;
      rankedIds = ranked.map((item) => item.id);
    } catch (error) {
      this.logger.warn(`Vector ranking unavailable for listing ${id}; using text fallback.`);
      const candidates = await this.prisma.listing.findMany({
        where: { status: 'ACTIVE', id: { not: id } },
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
            (source.city && candidate.city === source.city ? 1000 : 0) +
            (candidate.intentionTag === source.intentionTag ? 100 : 0) +
            this.descriptionSimilarity(source, candidate) * 10,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((candidate) => candidate.id);
    }

    if (rankedIds.length === 0) return [];
    const listings = await this.prisma.listing.findMany({
      where: { id: { in: rankedIds }, status: 'ACTIVE' },
      select: listingCardSelect,
    });
    const byId = new Map(listings.map((listing) => [listing.id, listing]));
    const ordered = rankedIds.map((listingId) => byId.get(listingId)).filter((listing): listing is NonNullable<typeof listing> => Boolean(listing));
    return Promise.all(ordered.map((listing) => this.withReadableImages(listing, 1)));
  }

  async update(id: string, userId: string, dto: UpdateListingDto) {
    this.assertManagedImages(dto.images);
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

    const updated = await this.prisma.listing.update({
      where: { id },
      data,
      include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
    });

    this.scheduleListingMatching(updated.id, 'listing_updated');
    void this.notifyIndexNow(updated.slug);
    return this.withReadableImages(updated);
  }

  async remove(id: string, userId: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException(`Listing not found`);
    if (listing.userId !== userId) throw new ForbiddenException('Not your listing');

    await this.prisma.listing.update({
      where: { id },
      data: { status: 'PAUSED' },
    });
    void this.notifyIndexNow(listing.slug);
    return { message: 'Listing removed from the marketplace' };
  }

  async saveListing(userId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
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
      where: { userId },
      include: {
        listing: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(saved.map((item) => this.withReadableImages(item.listing)));
  }

  async semanticSearch(params: {
    query?: string;
    category?: string;
    city?: string;
    intent?: string;
    limit?: number;
  }) {
    const query = params.query?.trim();
    const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);

    if (params.category && !LISTING_CATEGORIES.includes(params.category as (typeof LISTING_CATEGORIES)[number])) {
      throw new BadRequestException('Unknown listing category');
    }
    if (params.city && !NIGERIAN_STATES.includes(params.city as (typeof NIGERIAN_STATES)[number])) {
      throw new BadRequestException('Unknown Nigerian state');
    }
    if (params.intent && !Object.values(IntentionTag).includes(params.intent as IntentionTag)) {
      throw new BadRequestException('Unknown listing intention');
    }

    if (!query || !this.embeddingService.isConfigured()) {
      const fallback = await this.findAll({
        category: params.category,
        intentionTag: params.intent,
        city: params.city,
        search: query,
        limit,
      });
      return fallback.listings;
    }

    const queryEmbedding = await this.embeddingService.generateEmbedding(query);
    const vector = JSON.stringify(queryEmbedding);
    const categoryFilter = params.category ? Prisma.sql`AND l.category = ${params.category}` : Prisma.empty;
    const cityFilter = params.city ? Prisma.sql`AND l.city = ${params.city}` : Prisma.empty;
    const intentFilter = params.intent
      ? Prisma.sql`AND l."intentionTag"::text = ${params.intent}`
      : Prisma.empty;

    const results = await this.prisma.$queryRaw<
      Array<Record<string, unknown> & { images: string[]; relevance: number | string }>
    >`
      SELECT
        l.id,
        l.title,
        l.slug,
        l."intentionTag",
        l.price,
        l.status,
        l.images,
        l.city,
        l."createdAt",
        l."updatedAt",
        (1 - (l.embedding <=> ${vector}::vector)) AS relevance
      FROM "Listing" l
      WHERE l.status = 'ACTIVE'
        AND l.embedding IS NOT NULL
        ${categoryFilter}
        ${cityFilter}
        ${intentFilter}
      ORDER BY l.embedding <=> ${vector}::vector
      LIMIT ${limit}
    `;

    const listings = results
      .map((row) => {
        const relevance = Number(row.relevance);
        return { ...row, relevance };
      })
      .filter((row) => Number(row.relevance) > 0.5);
    return Promise.all(listings.map((listing) => this.withReadableImages(listing, 1)));
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

  private async storeListingEmbedding(listing: {
    id: string;
    title?: unknown;
    description?: unknown;
    category?: unknown;
    condition?: unknown;
    intentionTag?: unknown;
    pairingKeyword?: unknown;
    compatibilityAttributes?: unknown;
    city?: unknown;
    embeddingHash?: string | null;
    embeddingTextHash?: string | null;
    [key: string]: unknown;
  }) {
    if (!this.embeddingService.isConfigured()) return;

    const text = this.embeddingService.buildListingText(listing);
    const embeddingHash = this.embeddingService.hashText(text);

    if (listing.embeddingHash === embeddingHash || listing.embeddingTextHash === embeddingHash) {
      return;
    }

    const embedding = await this.embeddingService.generateEmbedding(text);
    const vector = JSON.stringify(embedding);

    await this.prisma.$executeRaw`
      UPDATE "Listing"
      SET embedding = ${vector}::vector,
          "embeddingHash" = ${embeddingHash},
          "embeddingTextHash" = ${embeddingHash},
          "embeddingId" = ${`openai:text-embedding-3-small:${embeddingHash.slice(0, 16)}`},
          "lastMatchedAt" = null
      WHERE id = ${listing.id}
    `;
  }

  private scheduleListingMatching(listingId: string, reason: string) {
    try {
      this.matchingService.scheduleMatchForListing(listingId, reason);
    } catch (error) {
      this.logger.error(`Could not schedule matching for listing ${listingId}`, error);
    }
  }
}
