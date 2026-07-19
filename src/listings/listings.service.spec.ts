import { Test, TestingModule } from '@nestjs/testing';
import { ListingsService } from './listings.service';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { EmbeddingService } from '../matching/embedding.service';
import { S3Service } from '../utils/s3.service';

describe('ListingsService', () => {
  let service: ListingsService;
  let prisma: {
    listing: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      listing: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MatchingService, useValue: { runMatchForListing: jest.fn() } },
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
});
