import { Test, TestingModule } from '@nestjs/testing';
import { ListingsService } from './listings.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../matching/embedding.service';
import { S3Service } from '../utils/s3.service';
import { MatchingJobsService } from '../matching/matching-jobs.service';
import { GuestAccessService } from '../auth/guest-access.service';

describe('ListingsService', () => {
  let service: ListingsService;
  let s3: {
    getReadableUrls: jest.Mock;
    getObjectKey: jest.Mock;
    markFilesAttached: jest.Mock;
    markFilesOrphaned: jest.Mock;
  };
  let prisma: {
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
    listing: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    upload: { findMany: jest.Mock; updateMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn(),
      $transaction: jest.fn(),
      listing: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      upload: { findMany: jest.fn(), updateMany: jest.fn() },
    };
    s3 = {
      getReadableUrls: jest.fn().mockImplementation((images: string[]) => images),
      getObjectKey: jest.fn(),
      markFilesAttached: jest.fn().mockResolvedValue(undefined),
      markFilesOrphaned: jest.fn().mockResolvedValue(undefined),
    };
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: MatchingJobsService,
          useValue: { enqueueListing: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: EmbeddingService,
          useValue: {
            isConfigured: jest.fn().mockReturnValue(false),
            generateQueryEmbedding: jest.fn(),
          },
        },
        {
          provide: S3Service,
          useValue: s3,
        },
        {
          provide: GuestAccessService,
          useValue: { verifyIdentityToken: jest.fn().mockReturnValue({ userId: 'guest-1' }) },
        },
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('returns lightweight active listing entries for the sitemap', async () => {
    const createdAt = new Date('2026-07-01T10:00:00.000Z');
    const updatedAt = new Date('2026-07-02T10:00:00.000Z');
    prisma.listing.findMany.mockResolvedValue([
      {
        id: 'listing-1',
        slug: 'useful-item-1',
        images: ['one.jpg', 'two.jpg'],
        createdAt,
        updatedAt,
      },
    ]);

    await expect(service.getSitemapEntries()).resolves.toEqual([
      {
        id: 'listing-1',
        slug: 'useful-item-1',
        imageCount: 2,
        createdAt,
        updatedAt,
      },
    ]);
    expect(prisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE', intentionTag: { not: 'WANTED' } }),
        take: 50_000,
      }),
    );
  });

  it('does not inflate listing views for metadata and crawler reads', async () => {
    prisma.listing.findFirst.mockResolvedValue({
      id: 'listing-1',
      images: [],
    });

    await service.findOne('listing-1', false);

    expect(prisma.listing.update).not.toHaveBeenCalled();
  });

  it('returns a lightweight feed and resolves only the card image', async () => {
    prisma.listing.findMany.mockResolvedValue([
      {
        id: 'listing-1',
        title: 'Chair',
        slug: 'chair-1',
        intentionTag: 'SELL',
        price: null,
        status: 'ACTIVE',
        images: ['first.jpg', 'second.jpg'],
        city: 'Lagos',
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        updatedAt: new Date('2026-07-01T10:00:00.000Z'),
      },
    ]);
    prisma.listing.count.mockResolvedValue(1);

    const result = await service.findAll({ page: 1, limit: 12 });

    expect(result.listings[0].images).toEqual(['first.jpg']);
    expect(s3.getReadableUrls).toHaveBeenCalledWith(['first.jpg']);
    expect(prisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          id: true,
          title: true,
          images: true,
          createdAt: true,
          updatedAt: true,
        }),
      }),
    );
  });

  it('exposes only the public guest contact fields in listing responses', async () => {
    prisma.listing.findFirst.mockResolvedValue({
      id: 'guest-listing',
      images: [],
      isGuestListing: true,
      guestContact: {
        method: 'EMAIL',
        value: 'seller@example.com',
        manageTokenHash: 'must-not-leak',
      },
    });

    const listing = await service.findOne('guest-listing', false);

    expect((listing as typeof listing & { guestContact?: unknown }).guestContact).toEqual({
      method: 'EMAIL',
      value: 'seller@example.com',
    });
  });

  it('creates a passwordless guest listing with normalized public contact details', async () => {
    prisma.listing.findUnique.mockResolvedValue(null);
    prisma.listing.create.mockResolvedValue({
      id: 'guest-listing',
      slug: 'chair-1',
      images: ['https://uploads.example/key'],
      isGuestListing: true,
      version: 1,
    });
    prisma.upload.findMany.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111', ownerId: 'guest-1', listingId: null, status: 'PENDING', s3Key: 'key' },
    ]);
    prisma.upload.updateMany.mockResolvedValue({ count: 1 });
    s3.getObjectKey.mockReturnValue('key');

    await service.createGuest({
      clientRequestId: '22222222-2222-4222-8222-222222222222',
      title: 'Chair',
      description: 'A useful chair in fair condition',
      category: 'Furniture & Home Decor',
      condition: 'FAIR',
      intentionTag: 'SELL',
      price: '5000',
      city: 'Lagos',
      images: ['https://uploads.example/key'],
      uploadIds: ['11111111-1111-4111-8111-111111111111'],
      contactMethod: 'WHATSAPP',
      contactValue: '0801 234 5678',
    } as never, 'guest-token');

    expect(prisma.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isGuestListing: true,
          guestContact: { method: 'WHATSAPP', value: '2348012345678' },
          user: { connect: { id: 'guest-1' } },
        }),
      }),
    );
    expect((service as any).matchingJobsService.enqueueListing).toHaveBeenCalledWith(
      prisma,
      'guest-listing',
      1,
      'guest_listing_created',
    );
    const createdData = prisma.listing.create.mock.calls[0][0].data;
    const lifetime = createdData.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(6.99 * 24 * 60 * 60 * 1000);
    expect(lifetime).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it('soft-deletes expired guest listings and releases their images', async () => {
    prisma.listing.findMany
      .mockResolvedValueOnce([{ id: 'guest-listing', slug: 'chair-1', images: ['https://uploads.example/key'] }])
      .mockResolvedValueOnce([]);
    prisma.listing.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.upload.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.expireListings()).resolves.toEqual({ expired: 0, deletedGuests: 1 });

    expect(prisma.listing.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { in: ['guest-listing'] },
        isGuestListing: true,
        status: { in: ['ACTIVE', 'PAUSED', 'EXPIRED', 'COMPLETED'] },
        expiresAt: { lte: expect.any(Date) },
      },
      data: { status: 'DELETED', images: [], version: { increment: 1 } },
    });
    expect(prisma.upload.updateMany).toHaveBeenCalledWith({
      where: { listingId: { in: ['guest-listing'] }, status: 'ATTACHED' },
      data: { listingId: null, status: 'PENDING', attachedAt: null },
    });
    expect(s3.markFilesOrphaned).toHaveBeenCalledWith(['https://uploads.example/key']);
  });

  it('does not let a guest pause and republish past the original seven-day deadline', async () => {
    prisma.listing.findUnique.mockResolvedValue({
      id: 'guest-listing',
      title: 'Chair',
      slug: 'chair-1',
      status: 'PAUSED',
      version: 2,
      images: [],
      userId: 'guest-1',
      isGuestListing: true,
      guestContact: { method: 'EMAIL', value: 'seller@example.com' },
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(service.updateGuestStatus('guest-listing', 'guest-token', 'ACTIVE', 2))
      .rejects.toThrow('seven-day limit');
    expect(prisma.listing.updateMany).not.toHaveBeenCalled();
  });

  it('searches every meaningful word across title, description, pairing term, category, and state', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('search index unavailable'));
    prisma.listing.findMany.mockResolvedValue([
      {
        id: 'listing-1',
        title: 'Dangote cement paper bag',
        description: 'Useful empty packaging for a craft project',
        pairingKeyword: 'cement bag',
        category: 'Tools & DIY',
        intentionTag: 'SELL',
        price: null,
        status: 'ACTIVE',
        images: [],
        city: 'Lagos',
        slug: 'dangote-cement-paper-bag',
        isGuestListing: true,
        createdAt: new Date('2026-07-20T10:00:00.000Z'),
        updatedAt: new Date('2026-07-20T10:00:00.000Z'),
      },
    ]);

    const result = await service.semanticSearch({ query: 'cement bag Lagos', limit: 12 });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ id: 'listing-1' }));
    expect(prisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          AND: expect.arrayContaining([
            expect.objectContaining({ OR: expect.any(Array) }),
          ]),
        }),
      }),
    );
  });

  it('ignores crawler views and records genuine browser views', async () => {
    await expect(service.trackView('listing-1', 'Googlebot/2.1')).resolves.toEqual({ tracked: false });
    expect(prisma.listing.updateMany).not.toHaveBeenCalled();

    prisma.listing.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.trackView('listing-1', 'Mozilla/5.0')).resolves.toEqual({ tracked: true });
    expect(prisma.listing.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'listing-1', status: 'ACTIVE', intentionTag: { not: 'WANTED' } }),
      data: { viewCount: { increment: 1 } },
    });
  });

  it('prioritizes product similarity before location for similar listings', async () => {
    const source = {
      id: 'source',
      title: 'AirPod Pro right earbud',
      description: 'Right replacement earbud',
      pairingKeyword: 'AirPod Pro right',
      city: 'Lagos',
      intentionTag: 'SELL',
      images: [],
    };
    const sameCity = {
      ...source,
      id: 'same-city',
      title: 'Wooden chair',
      description: 'Dining chair',
      pairingKeyword: null,
      intentionTag: 'TRADE',
    };
    const sameIntentAndDescription = {
      ...source,
      id: 'same-intent-description',
      city: 'Abuja',
    };
    const sameDescription = {
      ...source,
      id: 'same-description',
      city: 'Kano',
      intentionTag: 'DONATE',
    };
    const candidates = [sameDescription, sameIntentAndDescription, sameCity];

    prisma.listing.findFirst.mockResolvedValue(source);
    prisma.$queryRaw.mockRejectedValue(new Error('vector extension unavailable'));
    prisma.listing.findMany
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce(candidates);

    const result = await service.findSimilar(source.id, 3);

    expect(result.map((listing) => listing.id)).toEqual([
      'same-intent-description',
      'same-description',
      'same-city',
    ]);
  });
});
