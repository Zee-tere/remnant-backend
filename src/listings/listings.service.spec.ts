import { Test, TestingModule } from '@nestjs/testing';
import { ListingsService } from './listings.service';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { EmbeddingService } from '../matching/embedding.service';
import { S3Service } from '../utils/s3.service';

describe('ListingsService', () => {
  let service: ListingsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: PrismaService, useValue: {} },
        { provide: MatchingService, useValue: { runMatchForListing: jest.fn() } },
        { provide: EmbeddingService, useValue: { isConfigured: jest.fn().mockReturnValue(false) } },
        { provide: S3Service, useValue: { getReadableUrls: jest.fn(), getObjectKey: jest.fn() } },
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
