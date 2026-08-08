import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Listing, PairAlert, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../matching/embedding.service';
import { NotificationsService } from '../notifications/notifications.service';
import { S3Service } from '../utils/s3.service';
import { CreatePairAlertDto, UpdatePairAlertDto } from './pair-alerts.dto';

type AlertForMatching = PairAlert & { embeddingVector?: string | null };
type AlertAttributes = Record<string, string>;

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with']);
const PAIR_ALERT_ALGORITHM_VERSION = 'pair-alert-v2';

@Injectable()
export class PairAlertsService {
  private readonly logger = new Logger(PairAlertsService.name);
  private readonly threshold: number;
  private readonly maxCandidates: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly embeddingService: EmbeddingService,
    private readonly notificationsService: NotificationsService,
    private readonly s3Service: S3Service,
  ) {
    this.threshold = Number(this.configService.get<string>('PAIR_ALERT_SCORE_THRESHOLD', '0.48'));
    this.maxCandidates = Number(this.configService.get<string>('MATCH_MAX_CANDIDATES', '200'));
  }

  async create(userId: string, dto: CreatePairAlertDto) {
    this.assertCompatibilityAttributes(dto.compatibilityAttributes);
    const alert = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.pairAlert.create({
        data: {
          userId,
          query: dto.query.trim(),
          description: dto.description?.trim() || null,
          category: dto.category,
          city: dto.city || null,
          budget: dto.budget ? new Prisma.Decimal(dto.budget) : null,
          compatibilityAttributes: (dto.compatibilityAttributes ?? {}) as Prisma.InputJsonValue,
        },
      });
      await transaction.matchingJob.create({
        data: {
          entityType: 'PairAlert',
          entityId: created.id,
          entityVersion: created.version,
          reason: 'alert_created',
        },
      });
      return created;
    });
    return this.findOneForUser(alert.id, userId);
  }

  async findForUser(userId: string) {
    const alerts = await this.prisma.pairAlert.findMany({
      where: { userId, status: { not: 'ARCHIVED' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        matches: {
          where: {
            status: { not: 'DISMISSED' },
            listing: { status: 'ACTIVE', intentionTag: { not: 'WANTED' } },
          },
          orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
          take: 8,
          include: {
            listing: {
              include: { user: { select: { id: true, name: true, avatarUrl: true, trustTier: true } } },
            },
          },
        },
      },
    });

    return Promise.all(
      alerts.map(async (alert) => ({
        ...alert,
        matches: await Promise.all(
          alert.matches
            .filter((match) =>
              match.alertVersion === alert.version &&
              match.listingVersion === match.listing.version,
            )
            .map(async (match) => ({
            ...match,
            listing: {
              ...match.listing,
              images: await this.s3Service.getReadableUrls(match.listing.images.slice(0, 1)),
            },
            })),
        ),
      })),
    );
  }

  async update(id: string, userId: string, dto: UpdatePairAlertDto) {
    await this.assertOwner(id, userId);
    this.assertCompatibilityAttributes(dto.compatibilityAttributes);
    const data: Prisma.PairAlertUpdateInput = {};
    if (dto.query !== undefined) data.query = dto.query.trim();
    if (dto.description !== undefined) data.description = dto.description.trim() || null;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.city !== undefined) data.city = dto.city || null;
    if (dto.budget !== undefined) data.budget = dto.budget ? new Prisma.Decimal(dto.budget) : null;
    if (dto.compatibilityAttributes !== undefined) {
      data.compatibilityAttributes = dto.compatibilityAttributes as Prisma.InputJsonValue;
    }
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.query !== undefined || dto.description !== undefined || dto.category !== undefined || dto.compatibilityAttributes !== undefined) {
      data.embeddingHash = null;
    }

    data.version = { increment: 1 };
    const alert = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.pairAlert.update({ where: { id }, data });
      if (updated.status === 'ACTIVE') {
        await transaction.matchingJob.upsert({
          where: {
            entityType_entityId_entityVersion: {
              entityType: 'PairAlert',
              entityId: updated.id,
              entityVersion: updated.version,
            },
          },
          create: {
            entityType: 'PairAlert',
            entityId: updated.id,
            entityVersion: updated.version,
            reason: 'alert_updated',
          },
          update: {},
        });
      }
      return updated;
    });
    return this.findOneForUser(id, userId);
  }

  async remove(id: string, userId: string) {
    await this.assertOwner(id, userId);
    await this.prisma.pairAlert.delete({ where: { id } });
    return { message: 'Pair alert deleted' };
  }

  async updateMatchStatus(id: string, userId: string, status: 'VIEWED' | 'DISMISSED') {
    const match = await this.prisma.pairAlertMatch.findUnique({
      where: { id },
      include: { pairAlert: { select: { userId: true } } },
    });
    if (!match) throw new NotFoundException('Pair match not found');
    if (match.pairAlert.userId !== userId) throw new ForbiddenException('Not your pair match');
    return this.prisma.pairAlertMatch.update({ where: { id }, data: { status } });
  }

  async runMatchForAlert(alertId: string, reason = 'manual', expectedVersion?: number) {
    const found = await this.findAlertWithEmbedding(alertId);
    if (!found || found.status !== 'ACTIVE') return [];
    if (expectedVersion !== undefined && found.version !== expectedVersion) return [];
    let alert: AlertForMatching = found;
    let semanticScores = new Map<string, number>();
    const recentCandidates = await this.findSurfaceListingsForAlert(alert);
    const candidatesById = new Map(recentCandidates.map((listing) => [listing.id, listing]));
    let candidates = [...candidatesById.values()];
    let kept = candidates
      .map((listing) => this.score(alert, listing, semanticScores.get(listing.id) ?? 0))
      .filter((candidate) => candidate.score >= this.threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, 25);

    const minimumSurfaceMatches = Math.max(1, Number(process.env.SEMANTIC_MATCHING_MIN_SURFACE_RESULTS || 3));
    if (
      kept.length < minimumSurfaceMatches &&
      process.env.SEMANTIC_MATCHING_ENABLED === 'true' &&
      this.embeddingService.isConfigured()
    ) {
      alert = await this.ensureEmbedding(found);
      semanticScores = await this.semanticListingScores(alert);
      const missingSemanticIds = [...semanticScores.keys()].filter((id) => !candidatesById.has(id));
      if (missingSemanticIds.length > 0) {
        const semanticCandidates = await this.prisma.listing.findMany({
          where: {
            id: { in: missingSemanticIds },
            status: 'ACTIVE',
            category: alert.category,
            intentionTag: { not: 'WANTED' },
            OR: [{ isGuestListing: true }, { userId: { not: alert.userId } }],
          },
        });
        semanticCandidates.forEach((listing) => candidatesById.set(listing.id, listing));
      }
      candidates = [...candidatesById.values()];
      kept = candidates
        .map((listing) => this.score(alert, listing, semanticScores.get(listing.id) ?? 0))
        .filter((candidate) => candidate.score >= this.threshold)
        .sort((left, right) => right.score - left.score)
        .slice(0, 25);
    }

    await Promise.all(
      kept.map((candidate) => this.saveMatch(alert, candidate.listing, candidate.score, candidate.breakdown)),
    );

    await this.prisma.pairAlertMatch.deleteMany({
      where: {
        pairAlertId: alert.id,
        algorithmVersion: PAIR_ALERT_ALGORITHM_VERSION,
        ...(kept.length > 0 ? { listingId: { notIn: kept.map((candidate) => candidate.listing.id) } } : {}),
      },
    });

    await this.prisma.pairAlert.updateMany({
      where: { id: alert.id, version: alert.version },
      data: {
        lastMatchedAt: new Date(),
        matchedVersion: alert.version,
        matchingAlgorithmVersion: PAIR_ALERT_ALGORITHM_VERSION,
      },
    });
    this.logger.log(`${reason}: alert ${alert.id} kept ${kept.length} of ${candidates.length} candidates.`);
    return kept;
  }

  async runMatchForListing(listingId: string, reason = 'listing_created', expectedVersion?: number) {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing || listing.status !== 'ACTIVE' || listing.intentionTag === 'WANTED') return [];
    if (expectedVersion !== undefined && listing.version !== expectedVersion) return [];

    const recentAlerts = await this.findSurfaceAlertsForListing(listing);
    let semanticScores = new Map<string, number>();
    const alertsById = new Map(recentAlerts.map((alert) => [alert.id, alert]));
    let alerts = [...alertsById.values()];
    let kept = alerts
      .map((alert) => this.score(alert, listing, semanticScores.get(alert.id) ?? 0))
      .filter((candidate) => candidate.score >= this.threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, 25);

    const minimumSurfaceMatches = Math.max(1, Number(process.env.SEMANTIC_MATCHING_MIN_SURFACE_RESULTS || 3));
    if (
      kept.length < minimumSurfaceMatches &&
      process.env.SEMANTIC_MATCHING_ENABLED === 'true' &&
      this.embeddingService.isConfigured()
    ) {
      await this.ensureListingEmbedding(listing);
      semanticScores = await this.semanticAlertScores(listing.id);
      const missingSemanticIds = [...semanticScores.keys()].filter((id) => !alertsById.has(id));
      if (missingSemanticIds.length > 0) {
        const semanticAlerts = await this.prisma.pairAlert.findMany({
          where: {
            id: { in: missingSemanticIds },
            status: 'ACTIVE',
            category: listing.category,
            userId: { not: listing.userId },
          },
        });
        semanticAlerts.forEach((alert) => alertsById.set(alert.id, alert));
      }
      alerts = [...alertsById.values()];
      kept = alerts
        .map((alert) => this.score(alert, listing, semanticScores.get(alert.id) ?? 0))
        .filter((candidate) => candidate.score >= this.threshold)
        .sort((left, right) => right.score - left.score)
        .slice(0, 25);
    }

    await Promise.all(kept.map(async (candidate) => {
      const alert = alerts.find((item) => item.id === candidate.alertId);
      if (alert) await this.saveMatch(alert, listing, candidate.score, candidate.breakdown);
    }));
    this.logger.log(`${reason}: listing ${listing.id} matched ${kept.length} private alerts.`);
    return kept;
  }

  private async findOneForUser(id: string, userId: string) {
    const alerts = await this.findForUser(userId);
    const alert = alerts.find((item) => item.id === id);
    if (!alert) throw new NotFoundException('Pair alert not found');
    return alert;
  }

  private async assertOwner(id: string, userId: string) {
    const alert = await this.prisma.pairAlert.findUnique({ where: { id }, select: { userId: true } });
    if (!alert) throw new NotFoundException('Pair alert not found');
    if (alert.userId !== userId) throw new ForbiddenException('Not your pair alert');
  }

  private async findAlertWithEmbedding(id: string) {
    const [alert, rows] = await Promise.all([
      this.prisma.pairAlert.findUnique({ where: { id } }),
      this.prisma.$queryRaw<Array<{ embeddingVector: string | null }>>`
        SELECT pa.embedding::text AS "embeddingVector"
        FROM "PairAlert" pa
        WHERE pa.id = ${id}
        LIMIT 1
      `,
    ]);
    return alert ? { ...alert, embeddingVector: rows[0]?.embeddingVector ?? null } : null;
  }

  private async findSurfaceListingsForAlert(alert: PairAlert) {
    const where: Prisma.ListingWhereInput = {
      status: 'ACTIVE',
      category: alert.category,
      intentionTag: { not: 'WANTED' },
      OR: [{ isGuestListing: true }, { userId: { not: alert.userId } }],
    };
    const recent = await this.prisma.listing.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.maxCandidates,
    });
    const indexedIds = await this.findIndexedListingIdsForAlert(alert);
    const recentIds = new Set(recent.map((listing) => listing.id));
    const missingIds = indexedIds.filter((id) => !recentIds.has(id));
    const indexed = missingIds.length > 0
      ? await this.prisma.listing.findMany({ where: { ...where, id: { in: missingIds } } })
      : [];
    return [...new Map([...recent, ...indexed].map((listing) => [listing.id, listing])).values()];
  }

  private async findSurfaceAlertsForListing(listing: Listing) {
    const where: Prisma.PairAlertWhereInput = {
      status: 'ACTIVE',
      category: listing.category,
      userId: { not: listing.userId },
    };
    const recent = await this.prisma.pairAlert.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.maxCandidates,
    });
    const indexedIds = await this.findIndexedAlertIdsForListing(listing);
    const recentIds = new Set(recent.map((alert) => alert.id));
    const missingIds = indexedIds.filter((id) => !recentIds.has(id));
    const indexed = missingIds.length > 0
      ? await this.prisma.pairAlert.findMany({ where: { ...where, id: { in: missingIds } } })
      : [];
    return [...new Map([...recent, ...indexed].map((alert) => [alert.id, alert])).values()];
  }

  private async findIndexedListingIdsForAlert(alert: PairAlert) {
    const query = alert.query.trim().slice(0, 160);
    const attributes = this.surfaceAttributes(alert.compatibilityAttributes);
    const attributesJson = JSON.stringify(attributes);
    const attributePredicate = Object.keys(attributes).length > 0
      ? Prisma.sql`l."compatibilityAttributes" @> ${attributesJson}::jsonb`
      : Prisma.sql`FALSE`;
    const cityFilter = alert.city ? Prisma.sql`AND l.city = ${alert.city}` : Prisma.empty;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT l.id
        FROM "Listing" l
        WHERE l.status = 'ACTIVE'
          AND l."intentionTag" <> 'WANTED'
          AND l.category = ${alert.category}
          AND (l."isGuestListing" = TRUE OR l."userId" <> ${alert.userId})
          ${cityFilter}
          AND (
            ${attributePredicate}
            OR l."searchDocument" @@ websearch_to_tsquery('simple', ${query})
          )
        ORDER BY
          CASE WHEN ${attributePredicate} THEN 1 ELSE 0 END DESC,
          ts_rank_cd(l."searchDocument", websearch_to_tsquery('simple', ${query})) DESC,
          l."createdAt" DESC,
          l.id DESC
        LIMIT ${this.maxCandidates}
      `);
      return rows.map((row) => row.id);
    } catch (error) {
      this.logger.warn(`Indexed alert-to-listing lookup failed; using recent candidates. ${this.errorMessage(error)}`);
      return [];
    }
  }

  private async findIndexedAlertIdsForListing(listing: Listing) {
    const query = (listing.pairingKeyword || listing.title).trim().slice(0, 160);
    const attributes = this.surfaceAttributes(listing.compatibilityAttributes);
    const attributesJson = JSON.stringify(attributes);
    const attributePredicate = Object.keys(attributes).length > 0
      ? Prisma.sql`pa."compatibilityAttributes" @> ${attributesJson}::jsonb`
      : Prisma.sql`FALSE`;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT pa.id
        FROM "PairAlert" pa
        WHERE pa.status = 'ACTIVE'
          AND pa.category = ${listing.category}
          AND pa."userId" <> ${listing.userId}
          AND (
            ${attributePredicate}
            OR pa."searchDocument" @@ websearch_to_tsquery('simple', ${query})
          )
        ORDER BY
          CASE WHEN ${attributePredicate} THEN 1 ELSE 0 END DESC,
          ts_rank_cd(pa."searchDocument", websearch_to_tsquery('simple', ${query})) DESC,
          pa."createdAt" DESC,
          pa.id DESC
        LIMIT ${this.maxCandidates}
      `);
      return rows.map((row) => row.id);
    } catch (error) {
      this.logger.warn(`Indexed listing-to-alert lookup failed; using recent alerts. ${this.errorMessage(error)}`);
      return [];
    }
  }

  private async ensureEmbedding(alert: AlertForMatching) {
    const text = this.alertText(alert);
    const hash = this.embeddingService.contentHash(text);
    if (
      alert.embeddingVector &&
      alert.embeddingHash === hash &&
      alert.embeddingModel === this.embeddingService.model &&
      alert.embeddingPipelineVersion === this.embeddingService.pipelineVersion
    ) return alert;
    if (!this.embeddingService.isConfigured()) return alert;

    try {
      const vector = JSON.stringify(await this.embeddingService.generateEmbedding(text));
      await this.prisma.$executeRaw`
        UPDATE "PairAlert"
        SET embedding = ${vector}::vector,
            "embeddingHash" = ${hash},
            "embeddingModel" = ${this.embeddingService.model},
            "embeddingPipelineVersion" = ${this.embeddingService.pipelineVersion},
            "embeddedAt" = CURRENT_TIMESTAMP
        WHERE id = ${alert.id}
      `;
      return { ...alert, embeddingVector: vector, embeddingHash: hash };
    } catch (error) {
      this.logger.warn(`Could not embed pair alert ${alert.id}; using local text matching.`);
      return alert;
    }
  }

  private async semanticListingScores(alert: AlertForMatching) {
    const scores = new Map<string, number>();
    if (!alert.embeddingVector) return scores;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number | string }>>`
        SELECT l.id, (1 - (l.embedding <=> ${alert.embeddingVector}::vector)) AS score
        FROM "Listing" l
        WHERE l.status = 'ACTIVE' AND l.category = ${alert.category}
          AND l."intentionTag" <> 'WANTED' AND l.embedding IS NOT NULL
        ORDER BY l.embedding <=> ${alert.embeddingVector}::vector
        LIMIT ${this.maxCandidates}
      `;
      rows.forEach((row) => scores.set(row.id, Number(row.score)));
    } catch {
      this.logger.warn(`Vector lookup failed for pair alert ${alert.id}; using local text matching.`);
    }
    return scores;
  }

  private async semanticAlertScores(listingId: string) {
    const scores = new Map<string, number>();
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number | string }>>`
        SELECT pa.id, (1 - (pa.embedding <=> l.embedding)) AS score
        FROM "PairAlert" pa
        JOIN "Listing" l ON l.id = ${listingId}
        WHERE pa.status = 'ACTIVE' AND pa.category = l.category
          AND pa.embedding IS NOT NULL AND l.embedding IS NOT NULL
        ORDER BY pa.embedding <=> l.embedding
        LIMIT ${this.maxCandidates}
      `;
      rows.forEach((row) => scores.set(row.id, Number(row.score)));
    } catch {
      return scores;
    }
    return scores;
  }

  private async ensureListingEmbedding(listing: Listing) {
    const text = this.embeddingService.buildListingText(listing);
    const hash = this.embeddingService.contentHash(text);
    const rows = await this.prisma.$queryRaw<Array<{
      embeddingVector: string | null;
      embeddingHash: string | null;
      embeddingModel: string | null;
      embeddingPipelineVersion: number | null;
    }>>`
      SELECT embedding::text AS "embeddingVector", "embeddingHash",
        "embeddingModel", "embeddingPipelineVersion"
      FROM "Listing"
      WHERE id = ${listing.id}
      LIMIT 1
    `;
    const existing = rows[0];
    if (
      existing?.embeddingVector &&
      existing.embeddingHash === hash &&
      existing.embeddingModel === this.embeddingService.model &&
      existing.embeddingPipelineVersion === this.embeddingService.pipelineVersion
    ) return;

    try {
      const vector = JSON.stringify(await this.embeddingService.generateEmbedding(text));
      await this.prisma.$executeRaw`
        UPDATE "Listing"
        SET embedding = ${vector}::vector,
            "embeddingHash" = ${hash},
            "embeddingTextHash" = ${hash},
            "embeddingId" = ${`openai:${this.embeddingService.model}:${hash.slice(0, 16)}`},
            "embeddingModel" = ${this.embeddingService.model},
            "embeddingPipelineVersion" = ${this.embeddingService.pipelineVersion},
            "embeddedAt" = CURRENT_TIMESTAMP
        WHERE id = ${listing.id} AND version = ${listing.version}
      `;
    } catch (error) {
      this.logger.warn(`Could not embed listing ${listing.id} for alert retrieval; keeping surface matches.`);
    }
  }

  private score(alert: PairAlert, listing: Listing, semanticScore: number) {
    const localText = this.textSimilarity(this.alertText(alert), this.listingText(listing));
    const textScore = Math.max(localText, Number.isFinite(semanticScore) ? Math.max(0, semanticScore) : 0);
    const cityScore = !alert.city ? 0.5 : !listing.city ? 0.2 : alert.city.toLowerCase() === listing.city.toLowerCase() ? 1 : 0.1;
    const attributeScore = this.attributeScore(alert, listing);
    const intentScore = ['SELL', 'DONATE', 'TRADE'].includes(listing.intentionTag) ? 1 : 0.35;
    let score = textScore * 0.65 + cityScore * 0.15 + attributeScore * 0.15 + intentScore * 0.05;

    if (alert.budget && listing.intentionTag === 'SELL' && listing.price) {
      const budget = Number(alert.budget);
      const price = Number(listing.price);
      if (Number.isFinite(budget) && Number.isFinite(price) && price > budget * 1.25) score *= 0.55;
    }

    return {
      alertId: alert.id,
      listing,
      score: this.round(Math.min(1, score)),
      breakdown: {
        textScore: this.round(textScore),
        cityScore: this.round(cityScore),
        attributeScore: this.round(attributeScore),
        intentScore: this.round(intentScore),
        weights: { text: 0.65, city: 0.15, attributes: 0.15, intent: 0.05 },
      } as Prisma.InputJsonObject,
    };
  }

  private async saveMatch(alert: PairAlert, listing: Listing, score: number, breakdown: Prisma.InputJsonObject) {
    const match = await this.prisma.pairAlertMatch.upsert({
      where: { pairAlertId_listingId: { pairAlertId: alert.id, listingId: listing.id } },
      update: {
        score,
        scoreBreakdown: breakdown,
        algorithmVersion: PAIR_ALERT_ALGORITHM_VERSION,
        alertVersion: alert.version,
        listingVersion: listing.version,
      },
      create: {
        pairAlertId: alert.id,
        listingId: listing.id,
        score,
        scoreBreakdown: breakdown,
        algorithmVersion: PAIR_ALERT_ALGORITHM_VERSION,
        alertVersion: alert.version,
        listingVersion: listing.version,
      },
    });
    if (match.notifiedAt) return match;

    const claim = await this.prisma.pairAlertMatch.updateMany({
      where: { id: match.id, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    if (claim.count === 0) return match;

    const percent = Math.round(score * 100);
    try {
      await this.notificationsService.createNotification(
        alert.userId,
        'PAIR_MATCH',
        'A likely pair is available',
        `${listing.title} is a ${percent}% match for your “${alert.query}” alert.`,
        `/marketplace/${listing.slug || listing.id}`,
      );
    } catch (error) {
      await this.prisma.pairAlertMatch.update({ where: { id: match.id }, data: { notifiedAt: null } });
      this.logger.warn(
        `Match ${match.id} was saved, but its notification failed: ${this.errorMessage(error)}`,
      );
    }
    return match;
  }

  private alertText(alert: Pick<PairAlert, 'query' | 'description' | 'category' | 'compatibilityAttributes'>) {
    return [alert.query, alert.description, alert.category, ...Object.values(this.attributes(alert.compatibilityAttributes))]
      .filter(Boolean)
      .join(' ');
  }

  private listingText(listing: Listing) {
    return [listing.title, listing.description, listing.pairingKeyword, listing.category, ...Object.values(this.attributes(listing.compatibilityAttributes))]
      .filter(Boolean)
      .join(' ');
  }

  private attributeScore(alert: PairAlert, listing: Listing) {
    const desired = this.attributes(alert.compatibilityAttributes);
    const offered = this.attributes(listing.compatibilityAttributes);
    const keys = Object.keys(desired).filter((key) => !['flow', 'guestlisting', 'needspair'].includes(key));
    if (keys.length === 0) return 0.5;
    const scores = keys.map((key) => !offered[key] ? 0.2 : offered[key] === desired[key] ? 1 : 0);
    return scores.reduce((sum, value) => sum + value, 0) / scores.length;
  }

  private attributes(value: unknown): AlertAttributes {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined && item !== '')
        .map(([key, item]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), String(item).trim().toLowerCase()]),
    );
  }

  private surfaceAttributes(value: unknown): Record<string, string | number | boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const excluded = new Set(['flow', 'guestlisting', 'needspair', 'neededpiece', 'side', 'pieceidentifier']);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, item]) =>
          !excluded.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')) &&
          (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') &&
          item !== '',
        )
        .slice(0, 8) as Array<[string, string | number | boolean]>,
    );
  }

  private textSimilarity(left: string, right: string) {
    const leftPhrase = left.trim().toLowerCase();
    const rightPhrase = right.trim().toLowerCase();
    const leftTokens = this.tokens(leftPhrase);
    const rightTokens = this.tokens(rightPhrase);
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    const containment = intersection / leftTokens.size;
    const union = new Set([...leftTokens, ...rightTokens]).size;
    const phraseScore = rightPhrase.includes(leftPhrase) ? 1 : 0;
    return Math.max(phraseScore, containment * 0.9, union ? intersection / union : 0);
  }

  private tokens(value: string) {
    return new Set(value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
  }

  private round(value: number) {
    return Math.round(value * 1000) / 1000;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'Unknown error';
  }

  private assertCompatibilityAttributes(value?: Record<string, unknown>) {
    if (value === undefined) return;
    const serialized = JSON.stringify(value);
    if (serialized.length > 4_000) throw new BadRequestException('Compatibility details are too large');
    if (Object.keys(value).length > 30) throw new BadRequestException('Too many compatibility details');
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 60 || (typeof item === 'string' && item.length > 200)) {
        throw new BadRequestException('A compatibility detail is too long');
      }
    }
  }
}
