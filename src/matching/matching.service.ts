import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntentionTag, Listing, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmbeddingService } from './embedding.service';

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

const PROVIDER_INTENTS: IntentionTag[] = ['SELL', 'DONATE', 'FIX', 'RECYCLE'];
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
  car_parts: ['make', 'model', 'year', 'partType', 'side'],
  auto_parts: ['make', 'model', 'year', 'partType', 'side'],
  collectibles: ['setName', 'setSize', 'pieceIdentifier', 'era', 'artist'],
  art: ['setName', 'setSize', 'pieceIdentifier', 'artist', 'dimensions', 'era'],
  furniture: ['brand', 'collection', 'pieceType', 'color', 'dimensions'],
};

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  private readonly threshold: number;
  private readonly attributeWeight: number;
  private readonly semanticWeight: number;
  private readonly maxCandidates: number;
  private readonly priceTolerancePercent: number;
  private readonly requireCityMatch: boolean;
  private readonly pendingJobs = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private notificationsService: NotificationsService,
    private embeddingService: EmbeddingService,
  ) {
    this.threshold = parseFloat(this.configService.get<string>('MATCH_SCORE_THRESHOLD', '0.72'));
    this.attributeWeight = parseFloat(this.configService.get<string>('MATCH_ATTRIBUTE_WEIGHT', '0.65'));
    this.semanticWeight = parseFloat(this.configService.get<string>('MATCH_SEMANTIC_WEIGHT', '0.35'));
    this.maxCandidates = parseInt(this.configService.get<string>('MATCH_MAX_CANDIDATES', '200'), 10);
    this.priceTolerancePercent = parseFloat(this.configService.get<string>('MATCH_PRICE_TOLERANCE_PERCENT', '25'));
    this.requireCityMatch = this.configService.get<string>('MATCH_REQUIRE_CITY', 'false') === 'true';
  }

  scheduleMatchForListing(listingId: string, reason = 'listing_changed') {
    if (this.pendingJobs.has(listingId)) return;
    this.pendingJobs.add(listingId);

    setImmediate(() => {
      void this.runMatchForListing(listingId, reason)
        .catch((error) => {
          this.logger.error(`Failed matching job for ${listingId}`, error);
        })
        .finally(() => this.pendingJobs.delete(listingId));
    });
  }

  async runMatchForListing(listingId: string, reason = 'manual') {
    const listing = await this.findListingWithEmbedding(listingId);
    if (!listing || listing.status !== 'ACTIVE') return [];

    const listingWithEmbedding = await this.ensureEmbedding(listing);
    const candidates = await this.getHardFilteredCandidates(listingWithEmbedding);
    const scored = candidates
      .map((candidate) => this.scoreCandidate(listingWithEmbedding, candidate))
      .filter((candidate) => candidate.score >= this.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);

    const created: Awaited<ReturnType<typeof this.prisma.match.upsert>>[] = [];
    for (const candidate of scored) {
      const canonicalKey = this.getCanonicalKey(listingWithEmbedding.id, candidate.listing.id);
      const match = await this.prisma.match.upsert({
        where: { canonicalKey },
        update: {
          score: candidate.score,
          attributeScore: candidate.attributeScore,
          semanticScore: candidate.semanticScore,
          scoreBreakdown: candidate.breakdown,
        },
        create: {
          canonicalKey,
          listingAId: listingWithEmbedding.id,
          listingBId: candidate.listing.id,
          score: candidate.score,
          attributeScore: candidate.attributeScore,
          semanticScore: candidate.semanticScore,
          scoreBreakdown: candidate.breakdown,
        },
      });

      if (!match.notifiedAt) {
        await this.notifyMatchOwners(match.id, listingWithEmbedding, candidate.listing, candidate.score);
      }
      created.push(match);
    }

    await this.prisma.listing.update({
      where: { id: listingWithEmbedding.id },
      data: { lastMatchedAt: new Date() },
    });

    this.logger.log(
      `${reason}: ${listingWithEmbedding.id} scored ${candidates.length} candidates and kept ${created.length}.`,
    );
    return created;
  }

  async getMatchesForUser(userId: string) {
    const userListingIds = await this.prisma.listing.findMany({
      where: { userId },
      select: { id: true },
    });
    const ids = userListingIds.map((l) => l.id);

    return this.prisma.match.findMany({
      where: {
        OR: [{ listingAId: { in: ids } }, { listingBId: { in: ids } }],
      },
      include: {
        listingA: {
          include: { user: { select: { id: true, name: true, avatarUrl: true } } },
        },
        listingB: {
          include: { user: { select: { id: true, name: true, avatarUrl: true } } },
        },
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    });
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

    return this.prisma.match.update({
      where: { id },
      data: { status },
    });
  }

  async runDailyBackfill() {
    const activeListings = await this.prisma.listing.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    let totalMatches = 0;
    for (const listing of activeListings) {
      const matches = await this.runMatchForListing(listing.id, 'daily_backfill');
      totalMatches += matches.length;
    }

    this.logger.log(
      `Daily backfill complete. Found or refreshed ${totalMatches} matches across ${activeListings.length} listings.`,
    );
    return { status: 'backfill complete', scanned: activeListings.length, matches: totalMatches };
  }

  async runNightlyScan() {
    return this.runDailyBackfill();
  }

  private async findListingWithEmbedding(listingId: string) {
    const rows = await this.prisma.$queryRaw<ListingForMatching[]>`
      SELECT l.*, l.embedding::text AS "embeddingVector"
      FROM "Listing" l
      WHERE l.id = ${listingId}
      LIMIT 1
    `;

    return rows[0] ?? null;
  }

  private async ensureEmbedding(listing: ListingForMatching): Promise<ListingForMatching> {
    const text = this.embeddingService.buildListingText(listing);
    const hash = this.embeddingService.hashText(text);

    if (listing.embeddingVector && (listing.embeddingHash === hash || listing.embeddingTextHash === hash)) {
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
            "embeddingId" = ${`openai:text-embedding-3-small:${hash.slice(0, 16)}`},
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

    const candidates = await this.prisma.$queryRaw<ListingForMatching[]>`
      SELECT l.*, (1 - (l.embedding <=> ${listing.embeddingVector}::vector)) AS "semanticScore"
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

    return candidates.filter((candidate) => {
      if (!this.areIntentsCompatible(listing, candidate)) return false;
      if (!this.arePricesCompatible(listing, candidate)) return false;
      return true;
    });
  }

  private async getFallbackCandidates(listing: Listing) {
    const where: Prisma.ListingWhereInput = {
      id: { not: listing.id },
      category: listing.category,
      status: 'ACTIVE',
      userId: { not: listing.userId },
    };

    if (this.requireCityMatch && listing.city) {
      where.city = { equals: listing.city, mode: 'insensitive' };
    }

    const candidates = await this.prisma.listing.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: this.maxCandidates,
    });

    return candidates.filter((candidate) => {
      if (!this.areIntentsCompatible(listing, candidate)) return false;
      if (!this.arePricesCompatible(listing, candidate)) return false;
      return true;
    });
  }

  private getCompatibleIntents(intent: IntentionTag): IntentionTag[] {
    if (intent === 'WANTED') return PROVIDER_INTENTS;
    if (intent === 'TRADE') return ['TRADE'];
    return ['WANTED', 'TRADE', ...PROVIDER_INTENTS];
  }

  private areIntentsCompatible(a: Listing, b: Listing) {
    if (a.intentionTag === 'WANTED') return PROVIDER_INTENTS.includes(b.intentionTag);
    if (b.intentionTag === 'WANTED') return PROVIDER_INTENTS.includes(a.intentionTag);
    if (a.intentionTag === 'TRADE' && b.intentionTag === 'TRADE') return true;

    return this.hasStructuredComplementarity(a, b);
  }

  private arePricesCompatible(a: Listing, b: Listing) {
    const desired = a.intentionTag === 'WANTED' ? a : b.intentionTag === 'WANTED' ? b : null;
    const offered = desired?.id === a.id ? b : desired ? a : null;
    if (!desired || !offered || !desired.price || !offered.price) return true;

    const desiredPrice = Number(desired.price);
    const offeredPrice = Number(offered.price);
    if (!Number.isFinite(desiredPrice) || !Number.isFinite(offeredPrice)) return true;

    const upperBound = desiredPrice * (1 + this.priceTolerancePercent / 100);
    return offeredPrice <= upperBound;
  }

  private scoreCandidate(listing: ListingForMatching, candidate: ListingForMatching): ScoredCandidate {
    const attribute = this.scoreAttributes(listing, candidate);
    const semantic = this.scoreSemantic(listing, candidate);
    const cityScore = this.scoreCity(listing, candidate);
    const conditionScore = listing.condition === candidate.condition ? 1 : 0.6;
    const intentScore = this.scoreIntent(listing, candidate);

    const attributeScore = Math.min(
      1,
      attribute.score * 0.75 + cityScore * 0.1 + conditionScore * 0.05 + intentScore * 0.1,
    );
    const score = Math.min(
      1,
      attributeScore * this.attributeWeight + semantic * this.semanticWeight,
    );

    return {
      listing: candidate,
      score: this.round(score),
      attributeScore: this.round(attributeScore),
      semanticScore: this.round(semantic),
      breakdown: {
        attribute: attribute.breakdown,
        cityScore,
        conditionScore,
        intentScore,
        weights: { attribute: this.attributeWeight, semantic: this.semanticWeight },
      },
    };
  }

  private scoreAttributes(a: Listing, b: Listing) {
    const attrsA = this.normalizeAttributes(a.compatibilityAttributes as CompatibilityAttributes | null);
    const attrsB = this.normalizeAttributes(b.compatibilityAttributes as CompatibilityAttributes | null);
    const category = a.category.toLowerCase().replace(/\s+/g, '_');
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

  private scoreAttributeValue(key: string, left: string, right: string) {
    if (left === right) return key === 'side' ? 0.2 : 1;
    if (key === 'side' && COMPLEMENTARY_SIDES[left] === right) return 1;
    if (key === 'pieceidentifier') return 0.9;
    if (key === 'year') return this.scoreYear(left, right);
    if (key === 'size') return this.scoreSize(left, right);
    return 0;
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
    return union === 0 ? 0 : intersection / union;
  }

  private scoreCity(a: Listing, b: Listing) {
    if (!a.city || !b.city) return 0.5;
    return a.city.trim().toLowerCase() === b.city.trim().toLowerCase() ? 1 : 0;
  }

  private scoreIntent(a: Listing, b: Listing) {
    if (a.intentionTag === 'WANTED' || b.intentionTag === 'WANTED') return 1;
    if (a.intentionTag === 'TRADE' && b.intentionTag === 'TRADE') return 0.85;
    return this.hasStructuredComplementarity(a, b) ? 0.75 : 0;
  }

  private hasStructuredComplementarity(a: Listing, b: Listing) {
    const attrsA = this.normalizeAttributes(a.compatibilityAttributes as CompatibilityAttributes | null);
    const attrsB = this.normalizeAttributes(b.compatibilityAttributes as CompatibilityAttributes | null);
    return Boolean(attrsA.side && attrsB.side && COMPLEMENTARY_SIDES[attrsA.side] === attrsB.side);
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

  private async notifyMatchOwners(matchId: string, listing: Listing, candidate: Listing, score: number) {
    const percent = Math.round(score * 100);
    await Promise.all([
      this.notificationsService.createNotification(
        listing.userId,
        'PAIR_MATCH',
        'Pair match found',
        `${candidate.title} looks like a ${percent}% match for ${listing.title}.`,
        `/marketplace/${candidate.id}`,
      ),
      this.notificationsService.createNotification(
        candidate.userId,
        'PAIR_MATCH',
        'Pair match found',
        `${listing.title} looks like a ${percent}% match for ${candidate.title}.`,
        `/marketplace/${listing.id}`,
      ),
    ]);

    await this.prisma.match.update({
      where: { id: matchId },
      data: { notifiedAt: new Date() },
    });
  }

  private round(value: number) {
    return Math.round(value * 1000) / 1000;
  }
}
