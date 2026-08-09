import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../utils/s3.service';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  async uploadForOwner(ownerId: string, file: Express.Multer.File) {
    const url = await this.s3Service.uploadFile(file);
    const s3Key = this.s3Service.getObjectKey(url);
    if (!s3Key) {
      throw new InternalServerErrorException('Uploaded image could not be registered');
    }

    try {
      const upload = await this.prisma.upload.create({
        data: {
          ownerId,
          s3Key,
          byteSize: file.size,
          mimeType: file.mimetype,
        },
        select: { id: true },
      });
      return { id: upload.id, url };
    } catch (error) {
      try {
        await this.s3Service.deleteFile(s3Key);
      } catch (cleanupError) {
        this.logger.error(`Upload registry failed and ${s3Key} could not be removed`, cleanupError);
      }
      throw error;
    }
  }

  async cleanupPendingUploads(maxAgeHours = 24, limit = 100) {
    const createdBefore = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const pending = await this.prisma.upload.findMany({
      where: { status: 'PENDING', listingId: null, createdAt: { lt: createdBefore } },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
      select: { id: true, s3Key: true },
    });

    let deleted = 0;
    for (const upload of pending) {
      try {
        await this.s3Service.deleteFile(upload.s3Key);
        const result = await this.prisma.upload.updateMany({
          where: { id: upload.id, status: 'PENDING', listingId: null },
          data: { status: 'DELETED', deletedAt: new Date() },
        });
        deleted += result.count;
      } catch {
        this.logger.warn(`Pending upload ${upload.id} cleanup will retry`);
      }
    }
    return { examined: pending.length, deleted };
  }
}
