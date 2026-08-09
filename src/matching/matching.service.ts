import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntentionTag, Listing, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmbeddingService } from './embedding.service';
import { S3Service } from '../utils/s3.service';

type CompatibilityAttributes = Record<string, unknown>;

type ListingForMatching = Listing & {
  embeddingHash?: string | null;
  embeddingTextHash?: string | null;
  embeddingVector?: string | null;
  semanticScore?: number | string | null;
};

interface ScoredCandidate {
  listing: ListingForMatching;
  score: number;
  attributeScore: number;
  semanticScore: number;
  breakdown: Prisma.InputJsonObject;
}

export interface HardCompatibilityResult {
  compatible: boolean;
  rejectReason?: string;
}

const PROVIDER_INTENTS: IntentionTag[] = ['SELL', 'DONATE', 'FIX', 'RECYCLE'];
const MATCHING_ALGORITHM_VERSION = 'listing-pair-v2';
const COMPLEMENTARY_SIDES: Record<string, string> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
  upper: 'lower',
  lower: 'upper',
  front: 'back',
  back: 'front',
};

const CATEGORY_KEYS: Record<string, string[]> = {
  electronics: ['brand', 'model', 'generation', 'partType', 'side', 'color'],
  fashion: ['brand', 'size', 'colorway', 'side', 'gender', 'era'],
  shoes: ['brand', 'model', 'size', 'colorway', 'side'],
  accessories: ['brand', 'material', 'size', 'color', 'pieceIdentifier', 'setName'],
  car_parts: ['make', 'model', 'year', 'partType', 'side'],
  auto_parts: ['make', 'model', 'year', 'partType', 'side'],
  books: ['author', 'edition', 'isbn', 'volume', 'pieceIdentifier'],
  hobbies: ['brand', 'model', 'setName', 'pieceIdentifier', 'size'],
  sports: ['brand', 'model', 'size', 'side', 'pieceIdentifier'],
  kitchen: ['brand', 'model', 'collection', 'pieceType', 'color', 'dimensions'],
  tools: ['brand', 'model', 'partType', 'size'],
  collectibles: ['setName', 'setSize', 'pieceIdentifier', 'era', 'artist'],
  art: ['setName', 'setSize', 'pieceIdentifier', 'artist', 'dimensions', 'era'],
  furniture: ['brand', 'collection', 'pieceType', 'color', 'dimensions'],
  toys: ['brand', 'setName', 'setSize', 'pieceIdentifier', 'model'],
};

const CATEGORY_ALIASES: Record<string, string> = {
  electronics_and_gadgets: 'electronics',
  furniture_and_home_decor: 'furniture',
  clothing_and_fashion: 'fashion',
  shoes_and_footwear: 'shoes',
  accessories_and_jewelry: 'accessories',
  vehicles_and_auto_parts: 'auto_parts',
  books_and_education: 'books',
  hobbies_and_leisure: 'hobbies',
  sports_and_outdoor: 'sports',
  kitchen_and_home_essentials: 'kitchen',
  tools_and_diy: 'tools',
  collectibles_and_antiques: 'collectibles',
  toys_and_games: 'toys',
};

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  private readonly threshold: number;
  private readonly attributeWeight: number;
  private readonly semanticWeight: number;
  private readonly maxCandidates: number;
  private readonly requireCityMatch: boolean;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private notificationsService: NotificationsService,
    private embeddingService: EmbeddingService,
    private s3Service: S3Service,
  ) {
    this.threshold = parseFloat(this.configService.get<string>('MATCH_SCORE_THRESHOLD', '0.72'));
    this.attributeWeight = parseFloat(this.configService.get<string>('MATCH_ATTRIBUTE_WEIGHT', '0.65'));
    this.semanticWeight = parseFloat(this.configService.get<string>('MATCH_SEMANTIC_WEIGHT', '0.35'));
    this.maxCandidates = parseInt(this.configService.get<string>('MATCH_MAX_CANDIDATES', '200'), 10);
    this.requireCityMatch = this.configService.get<string>('MATCH_REQUIRE_CITY', 'false') === 'true';
  }

  async runMatchForListing(listingId: string, reason = 'manual', expectedVersion?: number) {
    const listing = await this.findListingWithEmbedding(listingId);
    if (!listing || listing.status !== 'ACTIVE' || listing.intentionTag === 'WANTED') return [];
    if (expectedVersion !== undefined && listing.version !== expectedVersion) return [];

    let listingWithEmbedding: ListingForMatching = listing;
    let candidates = await this.getFallbackCandidates(listing);
    let scored = candidates
      .filter((candidate) => this.passesHardCompatibility(listingWithEmbedding, candidate).compatible)
      .map((candidate) => this.scoreCandidate(listingWithEmbedding, candidate))
      .filter((candidate) => candidate.score >= this.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);

    const minimumSurfaceMatches = Math.max(1, Number(process.env.SEMANTIC_MATCHING_MIN_SURFACE_RESULTS || 3));
    if (
      scored.length < minimumSurfaceMatches &&
      process.env.SEMANTIC_MATCHING_ENABLED === 'true' &&
      this.embeddingService.isConfigured()
    ) {
      listingWithEmbedding = await this.ensureEmbedding(listing);
      candidates = await this.getHardFilteredCandidates(listingWithEmbedding);
      scored = candidates
        .filter((candidate) => this.passesHardCompatibility(listingWithEmbedding, candidate).compatible)
        .map((candidate) => this.scoreCandidate(listingWithEmbedding, candidate))
        .filter((candidate) => candidate.score >= this.threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, 25);
    }

    const created: Awaited<ReturnType<typeof this.prisma.match.upsert>>[] = [];
    for (const candidate of scored) {
      const canonicalKey = this.getCanonicalKey(listingWithEmbedding.id, candidate.listing.id);
      const [listingA, listingB] = listingWithEmbedding.id.localeCompare(candidate.listing.id) <= 0
        ? [listingWithEmbedding, candidate.listing]
        : [candidate.listing, listingWithEmbedding];
      const match = await this.prisma.match.upsert({
        where: { canonicalKey },
        update: {
          listingA: { connect: { id: listingA.id } },
          listingB: { connect: { id: listingB.id } },
          score: candidate.score,
          attributeScore: candidate.attributeScore,
          semanticScore: candidate.semanticScore,
          scoreBreakdown: candidate.breakdown,
          algorithmVersion: MATCHING_ALGORITHM_VERSION,
          listingAVersion: listingA.version,
          listingBVersion: listingB.version,
        },
        create: {
          canonicalKey,
          listingAId: listingA.id,
          listingBId: listingB.id,
          score: candidate.score,
          attributeScore: candidate.attributeScore,
          semanticScore: candidate.semanticScore,
          scoreBreakdown: candidate.breakdown,
          algorithmVersion: MATCHING_ALGORITHM_VERSION,
          listingAVersion: listingA.version,
          listingBVersion: listingB.version,
        },
      });

      await this.prisma.matchParticipantState.createMany({
        data: [
          { matchId: match.id, userId: listingWithEmbedding.userId },
          { matchId: match.id, userId: candidate.listing.userId },
        ],
        skipDuplicates: true,
      });

      const claim = await this.prisma.match.updateMany({
        where: { id: match.id, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
      if (claim.count === 1) {
        await this.notifyMatchOwners(match.id, listingWithEmbedding, candidate.listing);
      }
      created.push(match);
    }

    await this.prisma.listing.updateMany({
      where: { id: listingWithEmbedding.id, version: listingWithEmbedding.version },
      data: {
        lastMatchedAt: new Date(),
        matchedVersion: listingWithEmbedding.version,
        matchingAlgorithmVersion: MATCHING_ALGORITHM_VERSION,
      },
    });

    this.logger.log(
      `${reason}: ${listingWithEmbedding.id} scored ${candidates.length} candidates and kept ${created.length}.`,
    );
    return created;
  }

  async getMatchesForUser(userId: string) {
    const matches = await this.prisma.match.findMany({
      where: {
        AND: [
          { OR: [{ listingA: { userId } }, { listingB: { userId } }] },
          { listingA: { status: 'ACTIVE', intentionTag: { not: 'WANTED' } } },
          { listingB: { status: 'ACTIVE', intentionTag: { not: 'WANTED' } } },
        ],
      },
      include: {
        listingA: {
          include: { user: { select: { id: true, name: true, avatarUrl: true } } },
        },
        listingB: {
          include: { user: { select: { id: true, name: true, avatarUrl: true } } },
        },
        participantStates: { where: { userId }, select: { status: true } },
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return Promise.all(
      matches
        .filter((match) =>
          match.listingAVersion === match.listingA.version &&
          match.listingBVersion === match.listingB.version,
        )
        .map(async (match) => ({
        ...match,
        status: match.participantStates[0]?.status ?? match.status,
        participantStates: undefined,
        listingA: { ...match.listingA, images: await this.s3Service.getReadableUrls(match.listingA.images) },
        listingB: { ...match.listingB, images: await this.s3Service.getReadableUrls(match.listingB.images) },
        })),
    );
  }

  async updateMatchStatus(id: string, userId: string, status: 'VIEWED' | 'DISMISSED') {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: {
        listingA: { select: { userId: true } },
        listingB: { select: { userId: true } },
      },
    });
    if (!match) throw new NotFoundException('Match not found');
    if (match.listingA.userId !== userId && match.listingB.userId !== userId) {
      throw new ForbiddenException('Not your match');
    }

    return this.prisma.matchParticipantState.upsert({
      where: { matchId_userId: { matchId: id, userId } },
      create: {
        matchId: id,
        userId,
        status,
        viewedAt: status === 'VIEWED' ? new Date() : null,
        dismissedAt: status === 'DISMISSED' ? new Date() : null,
      },
      update: {
        status,
        ...(status === 'VIEWED' ? { viewedAt: new Date() } : {}),
        ...(status === 'DISMISSED' ? { dismissedAt: new Date() } : {}),
      },
    });
  }

  async runDailyBackfill() {
    const staleListings = await this.prisma.$queryRaw<Array<{ id: string; version: number }>>`
      SELECT l.id, l.version
      FROM "Listing" l
      WHERE l.status = 'ACTIVE'
        AND l."intentionTag" <> 'WANTED'
        AND (
          l."matchedVersion" IS DISTINCT FROM l.version
          OR l."matchingAlgorithmVersion" IS DISTINCT FROM ${MATCHING_ALGORITHM_VERSION}
        )
      ORDER BY l."updatedAt" ASC, l.id ASC
      LIMIT 500
    `;

    if (staleListings.length > 0) {
      await this.prisma.matchingJob.createMany({
        data: staleListings.map((listing) => ({
          entityType: 'Listing',
          entityId: listing.id,
          entityVersion: listing.version,
          reason: 'incremental_backfill',
        })),
        skipDuplicates: true,
      });
    }

    this.logger.log(`Incremental backfill queued ${staleListings.length} stale listing versions.`);
    return { status: 'backfill queued', queued: staleListings.length };
  }

  async runNightlyScan() {
    return this.runDailyBackfill();
  }

  private async findListingWithEmbedding(listingId: string) {
    const [listing, rows] = await Promise.all([
      this.prisma.listing.findUnique({ where: { id: listingId } }),
      this.prisma.$queryRaw<Array<{ embeddingVector: string | null }>>`
        SELECT l.embedding::text AS "embeddingVector"
        FROM "Listing" l
        WHERE l.id = ${listingId}
        LIMIT 1
      `,
    ]);

    return listing ? { ...listing, embeddingVector: rows[0]?.embeddingVector ?? null } : null;
  }

  private async ensureEmbedding(listing: ListingForMatching): Promise<ListingForMatching> {
    const text = this.embeddingService.buildListingText(listing);
    const hash = this.embeddingService.contentHash(text);

    if (
      listing.embeddingVector &&
      (listing.embeddingHash === hash || listing.embeddingTextHash === hash) &&
      listing.embeddingModel === this.embeddingService.model &&
      listing.embeddingPipelineVersion === this.embeddingService.pipelineVersion
    ) {
      return listing;
    }

    if (!this.embeddingService.isConfigured()) {
      this.logger.warn(`OPENAI_API_KEY is not configured; using local semantic fallback for ${listing.id}.`);
      return listing;
    }

    try {
      const embedding = await this.embeddingService.generateEmbedding(text);
      const vector = JSON.stringify(embedding);

      await this.prisma.$executeRaw`
        UPDATE "Listing"
        SET embedding = ${vector}::vector,
            "embeddingHash" = ${hash},
            "embeddingTextHash" = ${hash},
            "embeddingId" = ${`openai:${this.embeddingService.model}:${hash.slice(0, 16)}`},
            "embeddingModel" = ${this.embeddingService.model},
            "embeddingPipelineVersion" = ${this.embeddingService.pipelineVersion},
            "embeddedAt" = CURRENT_TIMESTAMP,
            "lastMatchedAt" = null
        WHERE id = ${listing.id}
      `;

      return {
        ...listing,
        embeddingHash: hash,
        embeddingTextHash: hash,
        embeddingVector: vector,
      };
    } catch (error) {
      this.logger.error(`Could not generate embedding for listing ${listing.id}`, error);
      return listing;
    }
  }

  private async getHardFilteredCandidates(listing: ListingForMatching) {
    if (!listing.embeddingVector) {
      return this.getFallbackCandidates(listing);
    }

    const compatibleIntents = this.getCompatibleIntents(listing.intentionTag);
    const cityFilter =
      this.requireCityMatch && listing.city
        ? Prisma.sql`AND l.city ILIKE ${listing.city}`
        : Prisma.empty;

    const fallbackCandidates = await this.getFallbackCandidates(listing);
    let vectorCandidates: ListingForMatching[] = [];
    try {
      const ranked = await this.prisma.$queryRaw<Array<{ id: string; semanticScore: number | string }>>`
        SELECT l.id, (1 - (l.embedding <=> ${listing.embeddingVector}::vector)) AS "semanticScore"
        FROM "Listing" l
        WHERE l.id != ${listing.id}
          AND l.category = ${listing.category}
          AND l.status = 'ACTIVE'
          AND l."userId" != ${listing.userId}
          AND l."intentionTag"::text IN (${Prisma.join(compatibleIntents)})
          AND l.embedding IS NOT NULL
          ${cityFilter}
        ORDER BY l.embedding <=> ${listing.embeddingVector}::vector
        LIMIT ${this.maxCandidates}
      `;
      const semanticById = new Map(ranked.map((row) => [row.id, Number(row.semanticScore)]));
      const rows = ranked.length > 0
        ? await this.prisma.listing.findMany({ where: { id: { in: ranked.map((row) => row.id) } } })
        : [];
      vectorCandidates = rows.map((candidate) => ({
        ...candidate,
        semanticScore: semanticById.get(candidate.id) ?? 0,
      }));
    } catch (error) {
      this.logger.warn(`Vector candidate lookup failed; using local matching. ${this.errorMessage(error)}`);
    }

    const candidatesById = new Map<string, ListingForMatching>(
      fallbackCandidates.map((candidate) => [candidate.id, candidate]),
    );
    vectorCandidates.forEach((candidate) => candidatesById.set(candidate.id, candidate));

    return [...candidatesById.values()].filter(
      (candidate) => this.passesHardCompatibility(listing, candidate).compatible,
    );
  }

  private async getFallbackCandidates(listing: Listing) {
    const where: Prisma.ListingWhereInput = {
      id: { not: listing.id },
      category: listing.category,
      status: 'ACTIVE',
      intentionTag: { not: 'WANTED' },
      userId: { not: listing.userId },
    };

    if (this.requireCityMatch && listing.city) {
      where.city = { equals: listing.city, mode: 'insensitive' };
    }

    const recentCandidates = await this.prisma.listing.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: this.maxCandidates,
    });

    const indexedIds = await this.findIndexedSurfaceCandidateIds(listing);
    const recentIds = new Set(recentCandidates.map((candidate) => candidate.id));
    const missingIds = indexedIds.filter((id) => !recentIds.has(id));
    const indexedCandidates = missingIds.length > 0
      ? await this.prisma.listing.findMany({ where: { ...where, id: { in: missingIds } } })
      : [];
    const candidates = [...new Map(
      [...recentCandidates, ...indexedCandidates].map((candidate) => [candidate.id, candidate]),
    ).values()];

    return candidates.filter(
      (candidate) => this.passesHardCompatibility(listing, candidate).compatible,
    );
  }

  passesHardCompatibility(a: Listing, b: Listing): HardCompatibilityResult {
    if (a.id === b.id) return { compatible: false, rejectReason: 'same_listing' };
    if (a.userId === b.userId) return { compatible: false, rejectReason: 'same_owner' };
    if (a.status !== 'ACTIVE' || b.status !== 'ACTIVE') {
      return { compatible: false, rejectReason: 'listing_unavailable' };
    }
    if (a.category !== b.category) {
      return { compatible: false, rejectReason: 'category_mismatch' };
    }
    if (!this.areIntentsCompatible(a, b)) {
      return { compatible: false, rejectReason: 'intent_not_complementary' };
    }

    const attrsA = this.getCompatibilityAttributes(a);
    const attrsB = this.getCompatibilityAttributes(b);
    const category = this.getCategoryKey(a.category);

    if (attrsA.pairingtype && attrsB.pairingtype && attrsA.pairingtype !== attrsB.pairingtype) {
      return { compatible: false, rejectReason: 'pairing_type_mismatch' };
    }

    if (attrsA.side && attrsB.side && COMPLEMENTARY_SIDES[attrsA.side] !== attrsB.side) {
      return { compatible: false, rejectReason: 'side_not_complementary' };
    }

    const sizeSystemA = attrsA.sizesystem ?? attrsA.sizeunit;
    const sizeSystemB = attrsB.sizesystem ?? attrsB.sizeunit;
    if (attrsA.size && attrsB.size) {
      if (sizeSystemA && sizeSystemB && sizeSystemA !== sizeSystemB) {
        return { compatible: false, rejectReason: 'size_system_mismatch' };
      }
      const leftSize = Number(attrsA.size);
      const rightSize = Number(attrsB.size);
      if (Number.isFinite(leftSize) && Number.isFinite(rightSize)) {
        const maxDelta = ['shoes', 'fashion', 'sports'].includes(category) ? 1 : 0.5;
        if (Math.abs(leftSize - rightSize) > maxDelta) {
          return { compatible: false, rejectReason: 'size_out_of_range' };
        }
      } else if (attrsA.size !== attrsB.size) {
        return { compatible: false, rejectReason: 'size_mismatch' };
      }
    }

    const exactKeysByCategory: Record<string, string[]> = {
      electronics: ['brand', 'model', 'generation'],
      shoes: ['brand', 'model'],
      auto_parts: ['make', 'model'],
      car_parts: ['make', 'model'],
      books: ['isbn', 'edition'],
      accessories: ['setname'],
      collectibles: ['setname'],
      toys: ['brand', 'setname', 'model'],
    };
    for (const key of exactKeysByCategory[category] ?? []) {
      if (attrsA[key] && attrsB[key] && attrsA[key] !== attrsB[key]) {
        return { compatible: false, rejectReason: `${key}_mismatch` };
      }
    }

    return { compatible: true };
  }

  private async findIndexedSurfaceCandidateIds(listing: Listing) {
    const query = (listing.pairingKeyword || listing.title).trim().slice(0, 160);
    const attributes = this.surfaceAttributes(listing.compatibilityAttributes);
    const attributesJson = JSON.stringify(attributes);
    const hasAttributes = Object.keys(attributes).length > 0;
    const attributePredicate = hasAttributes
      ? Prisma.sql`l."compatibilityAttributes" @> ${attributesJson}::jsonb`
      : Prisma.sql`FALSE`;
    const textPredicate = query
      ? Prisma.sql`l."searchDocument" @@ websearch_to_tsquery('simple', ${query})`
      : Prisma.sql`FALSE`;
    const cityFilter = this.requireCityMatch && listing.city
      ? Prisma.sql`AND l.city = ${listing.city}`
      : Prisma.empty;

    if (!hasAttributes && !query) return [];
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT l.id
        FROM "Listing" l
        WHERE l.id <> ${listing.id}
          AND l."userId" <> ${listing.userId}
          AND l.status = 'ACTIVE'
          AND l."intentionTag" <> 'WANTED'
          AND l.category = ${listing.category}
          ${cityFilter}
          AND (${attributePredicate} OR ${textPredicate})
        ORDER BY
          CASE WHEN ${attributePredicate} THEN 1 ELSE 0 END DESC,
          ts_rank_cd(l."searchDocument", websearch_to_tsquery('simple', ${query})) DESC,
          l."createdAt" DESC,
          l.id DESC
        LIMIT ${this.maxCandidates}
      `);
      return rows.map((row) => row.id);
    } catch (error) {
      this.logger.warn(`Indexed surface candidate lookup failed; using recent candidates. ${this.errorMessage(error)}`);
      return [];
    }
  }

  private getCompatibleIntents(intent: IntentionTag): IntentionTag[] {
    if (intent === 'TRADE') return ['TRADE'];
    return ['TRADE', ...PROVIDER_INTENTS];
  }

  private areIntentsCompatible(a: Listing, b: Listing) {
    if (a.intentionTag === 'TRADE' && b.intentionTag === 'TRADE') return true;

    return this.hasStructuredComplementarity(a, b);
  }

  private scoreCandidate(listing: ListingForMatching, candidate: ListingForMatching): ScoredCandidate {
    const attribute = this.scoreAttributes(listing, candidate);
    const semantic = this.scoreSemantic(listing, candidate);
    const cityScore = this.scoreCity(listing, candidate);
    const conditionScore = listing.condition === candidate.condition ? 1 : 0.6;
    const intentScore = this.scoreIntent(listing, candidate);

    if (attribute.breakdown.mode === 'text_fallback') {
      const pairScore = Math.max(attribute.score, semantic);
      const score = Math.min(1, pairScore * 0.65 + cityScore * 0.15 + intentScore * 0.15 + conditionScore * 0.05);
      return {
        listing: candidate,
        score: this.round(score),
        attributeScore: this.round(pairScore),
        semanticScore: this.round(semantic),
        breakdown: {
          attribute: attribute.breakdown,
          cityScore,
          intentScore,
          conditionScore,
          weights: { pair: 0.65, city: 0.15, intent: 0.15, condition: 0.05 },
        },
      };
    }

    const compatibilityScore = Math.min(
      1,
      attribute.score * this.attributeWeight + semantic * this.semanticWeight,
    );
    const score = Math.min(1, compatibilityScore * 0.7 + cityScore * 0.15 + intentScore * 0.1 + conditionScore * 0.05);

    return {
      listing: candidate,
      score: this.round(score),
      attributeScore: this.round(attribute.score),
      semanticScore: this.round(semantic),
      breakdown: {
        attribute: attribute.breakdown,
        cityScore,
        conditionScore,
        intentScore,
        weights: {
          compatibility: 0.7,
          city: 0.15,
          intent: 0.1,
          condition: 0.05,
          compatibilityMix: { attribute: this.attributeWeight, semantic: this.semanticWeight },
        },
      },
    };
  }

  private scoreAttributes(a: Listing, b: Listing) {
    const attrsA = this.getCompatibilityAttributes(a);
    const attrsB = this.getCompatibilityAttributes(b);
    const category = this.getCategoryKey(a.category);
    const keys = CATEGORY_KEYS[category] ?? ['brand', 'model', 'size', 'color', 'side', 'partType', 'setName', 'pieceIdentifier'];
    const considered: Record<string, Prisma.InputJsonValue> = {};

    let available = 0;
    let matched = 0;

    for (const key of keys) {
      const normalizedKey = this.normalizeKey(key);
      const left = attrsA[normalizedKey];
      const right = attrsB[normalizedKey];
      if (left === undefined || right === undefined) continue;

      available += 1;
      const keyScore = this.scoreAttributeValue(normalizedKey, left, right);
      matched += keyScore;
      considered[normalizedKey] = { left, right, score: this.round(keyScore) };
    }

    if (available === 0) {
      const titlePairScore = this.scoreSemanticText(a.pairingKeyword ?? a.title, b.pairingKeyword ?? b.title);
      return {
        score: Math.max(0.35, titlePairScore),
        breakdown: { mode: 'text_fallback', titlePairScore: this.round(titlePairScore) },
      };
    }

    return {
      score: matched / available,
      breakdown: { mode: 'structured_attributes', considered },
    };
  }

  private scoreAttributeValue(
    key: string,
    left: string,
    right: string,
  ) {
    if (key === 'side') {
      if (COMPLEMENTARY_SIDES[left] === right) return 1;
      return left === right ? 0.2 : 0;
    }
    if (left === right) return 1;
    if (key === 'pieceidentifier') return 0.9;
    if (key === 'year') return this.scoreYear(left, right);
    if (key === 'size') return this.scoreSize(left, right);
    return 0;
  }

  private getCategoryKey(category: string) {
    const normalized = category
      .trim()
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return CATEGORY_ALIASES[normalized] ?? normalized;
  }

  private scoreYear(left: string, right: string) {
    const a = parseInt(left, 10);
    const b = parseInt(right, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return left === right ? 1 : 0;
    const delta = Math.abs(a - b);
    if (delta === 0) return 1;
    if (delta <= 2) return 0.8;
    if (delta <= 5) return 0.4;
    return 0;
  }

  private scoreSize(left: string, right: string) {
    const a = parseFloat(left);
    const b = parseFloat(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return left === right ? 1 : 0;
    const delta = Math.abs(a - b);
    if (delta === 0) return 1;
    if (delta <= 0.5) return 0.8;
    if (delta <= 1) return 0.45;
    return 0;
  }

  private scoreSemantic(a: Listing, b: ListingForMatching) {
    if (b.semanticScore !== null && b.semanticScore !== undefined) {
      const semanticScore = Number(b.semanticScore);
      if (Number.isFinite(semanticScore)) return Math.min(1, Math.max(0, semanticScore));
    }

    return this.scoreSemanticText(this.buildSearchText(a), this.buildSearchText(b));
  }

  private scoreSemanticText(left: string, right: string) {
    const leftTokens = this.tokenize(left);
    const rightTokens = this.tokenize(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

    const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    const union = new Set([...leftTokens, ...rightTokens]).size;
    const smallerSet = Math.min(leftTokens.size, rightTokens.size);
    if (union === 0 || smallerSet === 0) return 0;
    const jaccard = intersection / union;
    const containment = intersection / smallerSet;
    return Math.max(jaccard, containment * 0.85);
  }

  private scoreCity(a: Listing, b: Listing) {
    if (!a.city || !b.city) return 0.5;
    return a.city.trim().toLowerCase() === b.city.trim().toLowerCase() ? 1 : 0;
  }

  private scoreIntent(a: Listing, b: Listing) {
    if (a.intentionTag === 'TRADE' && b.intentionTag === 'TRADE') return 0.85;
    return this.hasStructuredComplementarity(a, b) ? 0.75 : 0;
  }

  private hasStructuredComplementarity(a: Listing, b: Listing) {
    const attrsA = this.getCompatibilityAttributes(a);
    const attrsB = this.getCompatibilityAttributes(b);
    if (attrsA.neededpiece && this.scoreSemanticText(attrsA.neededpiece, this.buildSearchText(b)) >= 0.45) return true;
    if (attrsB.neededpiece && this.scoreSemanticText(attrsB.neededpiece, this.buildSearchText(a)) >= 0.45) return true;
    return Boolean(attrsA.side && attrsB.side && COMPLEMENTARY_SIDES[attrsA.side] === attrsB.side);
  }

  private getCompatibilityAttributes(listing: Listing) {
    const attributes = this.normalizeAttributes(
      listing.compatibilityAttributes as CompatibilityAttributes | null,
    );
    if (attributes.side) return attributes;

    const text = [listing.title, listing.description, listing.pairingKeyword]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const mentionedSides = Object.keys(COMPLEMENTARY_SIDES).filter((side) =>
      new RegExp(`\\b${side}\\b`, 'i').test(text),
    );
    if (mentionedSides.length === 1) {
      attributes.side = mentionedSides[0];
    }
    return attributes;
  }

  private normalizeAttributes(attributes?: CompatibilityAttributes | null): Record<string, string> {
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return {};

    return Object.fromEntries(
      Object.entries(attributes)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => [this.normalizeKey(key), String(value).trim().toLowerCase()]),
    );
  }

  private normalizeKey(key: string) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private buildSearchText(listing: Listing) {
    return this.embeddingService.buildListingText(listing);
  }

  private tokenize(text: string) {
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'to', 'in']);
    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 1 && !stopWords.has(token)),
    );
  }

  private getCanonicalKey(a: string, b: string) {
    return [a, b].sort().join(':');
  }

  private async notifyMatchOwners(matchId: string, listing: Listing, candidate: Listing) {
    const notifications: Promise<unknown>[] = [];
    if (!listing.isGuestListing) {
      notifications.push(this.notificationsService.createNotification(
        listing.userId,
        'PAIR_MATCH',
        'Pair match found',
        `${candidate.title} passed the compatibility rules for ${listing.title}. Review the details before arranging an exchange.`,
        `/marketplace/${candidate.id}`,
      ));
    }
    if (!candidate.isGuestListing) {
      notifications.push(this.notificationsService.createNotification(
        candidate.userId,
        'PAIR_MATCH',
        'Pair match found',
        `${listing.title} passed the compatibility rules for ${candidate.title}. Review the details before arranging an exchange.`,
        `/marketplace/${listing.id}`,
      ));
    }
    try {
      await Promise.all(notifications);
    } catch (error) {
      await this.prisma.match.updateMany({
        where: { id: matchId },
        data: { notifiedAt: null },
      });
      throw error;
    }
  }

  private round(value: number) {
    return Math.round(value * 1000) / 1000;
  }

  private surfaceAttributes(value: unknown): Record<string, string | number | boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const excluded = new Set(['flow', 'guestlisting', 'needspair', 'neededpiece', 'side', 'pieceidentifier']);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, item]) =>
          !excluded.has(this.normalizeKey(key)) &&
          (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') &&
          item !== '',
        )
        .slice(0, 8) as Array<[string, string | number | boolean]>,
    );
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'Unknown error';
  }
}
