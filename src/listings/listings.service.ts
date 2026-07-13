import { Injectable, NotFoundException, ForbiddenException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateListingDto, UpdateListingDto } from './listings.dto';
import { Prisma } from '@prisma/client';
import { MatchingService } from '../matching/matching.service';
import { EmbeddingService } from '../matching/embedding.service';
import { randomUUID } from 'crypto';
import { S3Service } from '../utils/s3.service';
import { IntentionTag } from '@prisma/client';
import { NIGERIAN_STATES } from '../config/nigeria-locations';
import { LISTING_CATEGORIES } from '../config/listing-taxonomy';

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
    return this.withReadableImages(listing);
  }

  async createGuest(dto: CreateListingDto) {
    const guestUser = await this.prisma.user.create({
      data: {
        email: `guest-${randomUUID()}@guest.remnant.local`,
        name: 'Guest',
        emailVerified: false,
      },
    });

    return this.create(guestUser.id, dto);
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
        include: {
          user: { select: { id: true, name: true, avatarUrl: true, city: true, trustTier: true } },
        },
      }),
      this.prisma.listing.count({ where }),
    ]);

    return {
      listings: await Promise.all(listings.map((listing) => this.withReadableImages(listing))),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true, city: true, trustTier: true } },
      },
    });
    if (!listing) throw new NotFoundException(`Listing not found`);

    // Increment view count
    await this.prisma.listing.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
    });

    return this.withReadableImages(listing);
  }

  async findBySlug(slug: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { slug },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true, city: true, trustTier: true } },
      },
    });
    if (!listing) throw new NotFoundException(`Listing not found`);

    await this.prisma.listing.update({
      where: { id: listing.id },
      data: { viewCount: { increment: 1 } },
    });

    return this.withReadableImages(listing);
  }

  async findByUser(userId: string) {
    const listings = await this.prisma.listing.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(listings.map((listing) => this.withReadableImages(listing)));
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
    const categoryFilter = params.category ? Prisma.sql`AND l.category ILIKE ${`%${params.category}%`}` : Prisma.empty;
    const cityFilter = params.city ? Prisma.sql`AND l.city ILIKE ${`%${params.city}%`}` : Prisma.empty;
    const intentFilter = params.intent
      ? Prisma.sql`AND l."intentionTag"::text = ${params.intent}`
      : Prisma.empty;

    const results = await this.prisma.$queryRaw<
      Array<Record<string, unknown> & { images: string[]; relevance: number | string }>
    >`
      SELECT l.*, (1 - (l.embedding <=> ${vector}::vector)) AS relevance
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
        const { embedding: _embedding, ...listing } = row;
        return { ...listing, relevance };
      })
      .filter((row) => Number(row.relevance) > 0.5);
    return Promise.all(listings.map((listing) => this.withReadableImages(listing)));
  }

  private async withReadableImages<T extends { images: string[] }>(listing: T): Promise<T> {
    return {
      ...listing,
      images: await this.s3Service.getReadableUrls(listing.images ?? []),
    };
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
