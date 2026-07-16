import { Test, TestingModule } from '@nestjs/testing';
import { MessagesService } from './messages.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { S3Service } from '../utils/s3.service';
import { GuestAccessService } from '../auth/guest-access.service';

describe('MessagesService', () => {
  let service: MessagesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: PrismaService, useValue: {} },
        { provide: NotificationsService, useValue: { createNotification: jest.fn() } },
        { provide: S3Service, useValue: { getReadableUrls: jest.fn() } },
        { provide: GuestAccessService, useValue: {} },
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
