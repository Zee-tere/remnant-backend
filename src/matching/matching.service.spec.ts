import { MatchingService } from './matching.service';

describe('MatchingService', () => {
  const config = { get: jest.fn((_key: string, fallback: string) => fallback) };
  const baseListing = {
    id: 'pot-1',
    userId: 'owner-1',
    title: '24 cm cooking pot without a lid',
    description: 'The pot is usable but needs its matching lid',
    category: 'Kitchen & Home Essentials',
    condition: 'GOOD',
    intentionTag: 'SELL',
    pairingKeyword: '24 cm cooking pot lid',
    compatibilityAttributes: {
      needsPair: true,
      neededPiece: '24 cm cooking pot lid',
      brand: 'HomeChef',
      model: 'Classic 24',
    },
    embeddingHash: null,
    embeddingId: null,
    embeddingTextHash: null,
    price: { toString: () => '50000' },
    status: 'ACTIVE',
    images: [],
    city: 'Lagos',
    createdAt: new Date(),
    updatedAt: new Date(),
    slug: 'cooking-pot-without-lid',
    viewCount: 0,
    expiresAt: null,
    lastMatchedAt: null,
    isGuestListing: false,
    guestContact: null,
  } as any;

  const candidate = {
    ...baseListing,
    id: 'lid-1',
    userId: 'seller-1',
    title: 'HomeChef 24 cm cooking pot lid',
    description: 'A replacement lid for the Classic 24 pot',
    pairingKeyword: null,
    compatibilityAttributes: { brand: 'HomeChef', model: 'Classic 24', pieceType: 'lid' },
    price: { toString: () => '48000' },
    slug: 'homechef-pot-lid',
  } as any;

  const createService = (prisma: Record<string, unknown> = {}, notifications = { createNotification: jest.fn().mockResolvedValue({}) }) =>
    new MatchingService(
      prisma as any,
      config as any,
      notifications as any,
      {
        isConfigured: jest.fn().mockReturnValue(false),
        buildListingText: jest.fn((listing) => [listing.title, listing.description, listing.pairingKeyword].filter(Boolean).join(' ')),
        hashText: jest.fn().mockReturnValue('hash'),
      } as any,
      { getReadableUrls: jest.fn() } as any,
    );

  it('matches a public incomplete item with a listing for its missing piece', async () => {
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
    const service = createService(prisma, notifications);

    const matches = await service.runMatchForListing(baseListing.id, 'test');

    expect(matches).toHaveLength(1);
    expect(prisma.match.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { canonicalKey: 'lid-1:pot-1' },
        create: expect.objectContaining({ listingAId: 'pot-1', listingBId: 'lid-1' }),
      }),
    );
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
  });

  it('ignores legacy wanted listings in the public matcher', async () => {
    const legacy = { ...baseListing, intentionTag: 'WANTED' };
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ ...legacy, embeddingVector: null }]) };
    const service = createService(prisma);

    await expect(service.runMatchForListing(legacy.id, 'test')).resolves.toEqual([]);
  });

  it('prevents users from updating matches they do not own', async () => {
    const service = createService({
      match: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'match-1',
          listingA: { userId: 'owner-a' },
          listingB: { userId: 'owner-b' },
        }),
      },
    });

    await expect(service.updateMatchStatus('match-1', 'intruder', 'VIEWED')).rejects.toThrow('Not your match');
  });

  it('maps public taxonomy labels to category-specific attributes', () => {
    const service = createService();
    const first = {
      ...baseListing,
      category: 'Clothing & Fashion',
      compatibilityAttributes: { brand: 'Remnant', size: '10', colorway: 'green', gender: 'women', era: '2020s' },
    };
    const offered = { ...candidate, ...first, id: 'fashion-2', userId: 'seller-2' };

    const result = (service as any).scoreAttributes(first, offered);

    expect(result.score).toBe(1);
    expect(result.breakdown.considered).toEqual(expect.objectContaining({
      colorway: expect.objectContaining({ score: 1 }),
      gender: expect.objectContaining({ score: 1 }),
      era: expect.objectContaining({ score: 1 }),
    }));
  });

  it('recognizes complementary sides from listing copy', () => {
    const service = createService();
    const left = { ...candidate, title: 'Left AirPod Pro 2 earbud', description: 'Left earbud only', pairingKeyword: null, compatibilityAttributes: {} };
    const right = { ...candidate, id: 'right-1', title: 'Right AirPod Pro 2 earbud', description: 'Right earbud only', pairingKeyword: null, compatibilityAttributes: {} };

    expect((service as any).hasStructuredComplementarity(left, right)).toBe(true);
  });

  it('gives same-state matches a decisive score advantage', () => {
    const service = createService();
    const nearby = { ...candidate, city: 'Lagos' };
    const distant = { ...candidate, id: 'distant', city: 'Kano' };

    const nearbyScore = (service as any).scoreCandidate(baseListing, nearby).score;
    const distantScore = (service as any).scoreCandidate(baseListing, distant).score;

    expect(nearbyScore).toBeGreaterThanOrEqual(0.72);
    expect(nearbyScore - distantScore).toBeGreaterThanOrEqual(0.2);
  });
});
