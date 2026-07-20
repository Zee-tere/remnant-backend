import { Test, TestingModule } from '@nestjs/testing';
import { ListingsService } from './listings.service';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { EmbeddingService } from '../matching/embedding.service';
import { S3Service } from '../utils/s3.service';

describe('ListingsService', () => {
  let service: ListingsService;
  let prisma: {
    $queryRaw: jest.Mock;
    listing: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn(),
      listing: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MatchingService, useValue: { scheduleMatchForListing: jest.fn() } },
        { provide: EmbeddingService, useValue: { isConfigured: jest.fn().mockReturnValue(false) } },
        {
          provide: S3Service,
          useValue: {
            getReadableUrls: jest.fn().mockImplementation((images: string[]) => images),
            getObjectKey: jest.fn(),
          },
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
        where: { status: 'ACTIVE' },
        take: 50_000,
      }),
    );
  });

  it('does not inflate listing views for metadata and crawler reads', async () => {
    prisma.listing.findUnique.mockResolvedValue({
      id: 'listing-1',
      images: [],
    });

    await service.findOne('listing-1', false);

    expect(prisma.listing.update).not.toHaveBeenCalled();
  });

  it('does not expose guest contact details in ordinary listing responses', async () => {
    prisma.listing.findUnique.mockResolvedValue({
      id: 'guest-listing',
      images: [],
      isGuestListing: true,
      guestContact: { email: 'seller@example.com' },
    });

    const listing = await service.findOne('guest-listing', false);

    expect((listing as typeof listing & { guestContact?: unknown }).guestContact).toBeUndefined();
  });

  it('returns guest contact details only through the dedicated contact lookup', async () => {
    prisma.listing.findFirst.mockResolvedValue({
      isGuestListing: true,
      guestContact: { phone: '+234 800 000 0000', telegram: 'https://t.me/remnantseller' },
      compatibilityAttributes: { guestListing: true },
    });

    await expect(service.getGuestContact('guest-listing')).resolves.toEqual({
      phone: '+234 800 000 0000',
      email: undefined,
      telegram: 'https://t.me/remnantseller',
    });
  });

  it('creates a guest listing and seller together with validated contact details', async () => {
    prisma.listing.create.mockResolvedValue({
      id: 'guest-listing',
      slug: 'chair-1',
      images: [],
      isGuestListing: true,
      guestContact: { email: 'seller@example.com' },
    });

    await service.createGuest({
      title: 'Chair',
      description: 'Chair',
      category: 'Furniture',
      condition: 'FAIR',
      intentionTag: 'SELL',
      price: '5000',
      city: 'Lagos',
      images: [],
      guestContact: { email: 'Seller@Example.com' },
    } as never);

    expect(prisma.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isGuestListing: true,
          guestContact: { email: 'seller@example.com' },
          user: { create: expect.objectContaining({ name: 'Guest' }) },
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
      where: { id: 'listing-1', status: 'ACTIVE' },
      data: { viewCount: { increment: 1 } },
    });
  });

  it('prioritizes location, then intent, then description for similar listings', async () => {
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

    prisma.listing.findUnique.mockResolvedValue(source);
    prisma.$queryRaw.mockRejectedValue(new Error('vector extension unavailable'));
    prisma.listing.findMany
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce(candidates);

    const result = await service.findSimilar(source.id, 3);

    expect(result.map((listing) => listing.id)).toEqual([
      'same-city',
      'same-intent-description',
      'same-description',
    ]);
  });
});
