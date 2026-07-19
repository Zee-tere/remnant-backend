import { MatchingService } from './matching.service';

describe('MatchingService', () => {
  const config = {
    get: jest.fn((key: string, fallback: string) => fallback),
  };

  const baseListing = {
    id: 'wanted-1',
    userId: 'buyer-1',
    title: 'Need right AirPod Pro 2',
    description: 'Looking for the right side only',
    category: 'electronics',
    condition: 'GOOD',
    intentionTag: 'WANTED',
    pairingKeyword: 'AirPod Pro right',
    compatibilityAttributes: { brand: 'Apple', model: 'AirPod Pro 2', side: 'right' },
    embeddingHash: null,
    embeddingId: null,
    embeddingTextHash: null,
    price: { toString: () => '50000' },
    status: 'ACTIVE',
    images: [],
    city: 'Lagos',
    createdAt: new Date(),
    updatedAt: new Date(),
    slug: 'need-right-airpod',
    viewCount: 0,
    expiresAt: null,
    lastMatchedAt: null,
  } as any;

  const candidate = {
    ...baseListing,
    id: 'sell-1',
    userId: 'seller-1',
    title: 'Apple AirPod Pro 2 right side',
    intentionTag: 'SELL',
    pairingKeyword: 'AirPod Pro right',
    price: { toString: () => '48000' },
  } as any;

  const createService = (prisma: Record<string, unknown> = {}) =>
    new MatchingService(
      prisma as any,
      config as any,
      { createNotification: jest.fn().mockResolvedValue({}) } as any,
      {
        isConfigured: jest.fn().mockReturnValue(false),
        buildListingText: jest.fn((listing) => [listing.title, listing.description].join(' ')),
        hashText: jest.fn().mockReturnValue('hash'),
      } as any,
      { getReadableUrls: jest.fn() } as any,
    );

  it('creates a high-confidence match and notifies both owners', async () => {
    const prisma = {
      listing: {
        findMany: jest.fn().mockResolvedValue([candidate]),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ ...baseListing, embeddingVector: null }]),
      match: {
        upsert: jest.fn().mockResolvedValue({ id: 'match-1', notifiedAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const notifications = { createNotification: jest.fn().mockResolvedValue({}) };
    const embedding = {
      isConfigured: jest.fn().mockReturnValue(false),
      buildListingText: jest.fn((listing) => [listing.title, listing.description].join(' ')),
      hashText: jest.fn().mockReturnValue('hash'),
    };

    const service = new MatchingService(
      prisma as any,
      config as any,
      notifications as any,
      embedding as any,
      { getReadableUrls: jest.fn() } as any,
    );
    const matches = await service.runMatchForListing(baseListing.id, 'test');

    expect(matches).toHaveLength(1);
    expect(prisma.match.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { canonicalKey: 'sell-1:wanted-1' },
        create: expect.objectContaining({
          listingAId: 'wanted-1',
          listingBId: 'sell-1',
          score: expect.any(Number),
          attributeScore: expect.any(Number),
          semanticScore: expect.any(Number),
        }),
      }),
    );
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
  });

  it('prevents users from updating matches they do not own', async () => {
    const prisma = {
      match: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'match-1',
          listingA: { userId: 'owner-a' },
          listingB: { userId: 'owner-b' },
        }),
      },
    };

    const service = new MatchingService(
      prisma as any,
      config as any,
      { createNotification: jest.fn() } as any,
      { isConfigured: jest.fn().mockReturnValue(false) } as any,
      { getReadableUrls: jest.fn() } as any,
    );

    await expect(service.updateMatchStatus('match-1', 'intruder', 'VIEWED')).rejects.toThrow('Not your match');
  });

  it('maps public taxonomy labels to their category-specific attributes', () => {
    const service = createService();
    const wanted = {
      ...baseListing,
      category: 'Clothing & Fashion',
      compatibilityAttributes: {
        brand: 'Remnant',
        size: '10',
        colorway: 'green',
        gender: 'women',
        era: '2020s',
      },
    };
    const offered = {
      ...candidate,
      category: 'Clothing & Fashion',
      compatibilityAttributes: {
        brand: 'Remnant',
        size: '10',
        colorway: 'green',
        gender: 'women',
        era: '2020s',
      },
    };

    const result = (service as any).scoreAttributes(wanted, offered);

    expect(result.score).toBe(1);
    expect(result.breakdown.considered).toEqual(
      expect.objectContaining({
        colorway: expect.objectContaining({ score: 1 }),
        gender: expect.objectContaining({ score: 1 }),
        era: expect.objectContaining({ score: 1 }),
      }),
    );
  });

  it('matches the requested side for wanted listings and complementary sides for pair listings', () => {
    const service = createService();
    const wantedRight = {
      ...baseListing,
      compatibilityAttributes: { brand: 'Apple', model: 'AirPod Pro 2', side: 'right' },
    };
    const offeredRight = {
      ...candidate,
      compatibilityAttributes: { brand: 'Apple', model: 'AirPod Pro 2', side: 'right' },
    };
    const offeredLeft = {
      ...candidate,
      compatibilityAttributes: { brand: 'Apple', model: 'AirPod Pro 2', side: 'left' },
    };
    const pairLeft = { ...offeredLeft, intentionTag: 'SELL' };
    const pairRight = { ...offeredRight, intentionTag: 'SELL' };

    expect((service as any).scoreAttributes(wantedRight, offeredRight).score).toBe(1);
    expect((service as any).scoreAttributes(wantedRight, offeredLeft).score).toBeLessThan(1);
    expect((service as any).scoreAttributes(pairLeft, pairRight).score).toBe(1);
  });

  it('infers a single side from listing copy when structured attributes are absent', () => {
    const service = createService();
    const leftPiece = {
      ...candidate,
      title: 'Left AirPod Pro 2 earbud',
      description: 'The left earbud only',
      pairingKeyword: null,
      compatibilityAttributes: {},
    };
    const rightPiece = {
      ...candidate,
      id: 'sell-2',
      userId: 'seller-2',
      title: 'Right AirPod Pro 2 earbud',
      description: 'The right earbud only',
      pairingKeyword: null,
      compatibilityAttributes: {},
    };

    expect((service as any).hasStructuredComplementarity(leftPiece, rightPiece)).toBe(true);
  });
});
