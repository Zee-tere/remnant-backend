import { PairAlertsService } from './pair-alerts.service';

describe('PairAlertsService', () => {
  const alert = {
    id: 'alert-1',
    userId: 'buyer-1',
    query: '24 cm cooking pot lid',
    description: 'HomeChef Classic lid',
    category: 'Kitchen & Home Essentials',
    city: 'Lagos',
    budget: null,
    compatibilityAttributes: { brand: 'HomeChef', model: 'Classic 24' },
    embeddingHash: null,
    status: 'ACTIVE',
    lastMatchedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;

  const listing = {
    id: 'lid-1',
    userId: 'seller-1',
    title: 'HomeChef 24 cm cooking pot lid',
    description: 'Replacement lid for a Classic 24 pot',
    slug: 'homechef-pot-lid',
    category: 'Kitchen & Home Essentials',
    condition: 'GOOD',
    intentionTag: 'SELL',
    pairingKeyword: null,
    compatibilityAttributes: { brand: 'HomeChef', model: 'Classic 24' },
    isGuestListing: false,
    guestContact: null,
    price: null,
    status: 'ACTIVE',
    images: [],
    city: 'Lagos',
    viewCount: 0,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    embeddingHash: null,
    embeddingId: null,
    embeddingTextHash: null,
    lastMatchedAt: null,
  } as any;

  const createService = (prisma: Record<string, unknown>, notifications = { createNotification: jest.fn().mockResolvedValue({}) }) =>
    new PairAlertsService(
      prisma as any,
      { get: jest.fn((_key: string, fallback: string) => fallback) } as any,
      {
        isConfigured: jest.fn().mockReturnValue(false),
        hashText: jest.fn().mockReturnValue('hash'),
      } as any,
      notifications as any,
      { getReadableUrls: jest.fn((images) => images) } as any,
    );

  it('loads alerts only for the signed-in owner', async () => {
    const prisma = { pairAlert: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = createService(prisma);

    await expect(service.findForUser('buyer-1')).resolves.toEqual([]);
    expect(prisma.pairAlert.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'buyer-1', status: { not: 'ARCHIVED' } },
    }));
  });

  it('weights a same-state match above the same item in another state', () => {
    const service = createService({});
    const nearby = (service as any).score(alert, listing, 0).score;
    const distant = (service as any).score(alert, { ...listing, city: 'Kano' }, 0).score;

    expect(nearby).toBeGreaterThanOrEqual(0.72);
    expect(nearby - distant).toBeGreaterThanOrEqual(0.25);
  });

  it('creates a private alert match when a qualifying listing appears', async () => {
    const prisma = {
      listing: { findUnique: jest.fn().mockResolvedValue(listing) },
      pairAlert: { findMany: jest.fn().mockResolvedValue([alert]) },
      pairAlertMatch: {
        upsert: jest.fn().mockResolvedValue({ id: 'pair-match-1', notifiedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const notifications = { createNotification: jest.fn().mockResolvedValue({}) };
    const service = createService(prisma, notifications);

    const matches = await service.runMatchForListing(listing.id, 'test');

    expect(matches).toHaveLength(1);
    expect(prisma.pairAlertMatch.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { pairAlertId_listingId: { pairAlertId: alert.id, listingId: listing.id } },
    }));
    expect(notifications.createNotification).toHaveBeenCalledWith(
      alert.userId,
      'PAIR_MATCH',
      'A likely pair is available',
      expect.stringContaining(alert.query),
      `/marketplace/${listing.slug}`,
    );
  });
});
