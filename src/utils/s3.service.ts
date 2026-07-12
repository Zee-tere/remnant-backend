import { Injectable, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';

const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function hasAllowedImageSignature(file: Express.Multer.File) {
  const buffer = file.buffer;
  if (!buffer || buffer.length < 12) return false;

  if (file.mimetype === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (file.mimetype === 'image/png') {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  if (file.mimetype === 'image/webp') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }

  return false;
}

@Injectable()
export class S3Service {
  private s3Client: S3Client;
  private bucketName: string;
  private region: string;
  private publicBaseUrl?: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET')?.trim() ?? '';
    this.region = this.configService.get<string>('AWS_REGION', 'us-east-1')!;
    this.publicBaseUrl = this.configService.get<string>('AWS_S3_PUBLIC_BASE_URL')?.replace(/\/$/, '');

    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');

    this.s3Client = new S3Client({
      region: this.region,
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
            },
          }
        : {}),
    });
  }

  async uploadFile(file: Express.Multer.File): Promise<string> {
    if (!file) throw new BadRequestException('No file provided for upload.');
    if (!this.bucketName) {
      console.error('[S3Service] AWS_S3_BUCKET is not configured');
      throw new InternalServerErrorException('Uploads are not configured yet. Please try again shortly.');
    }

    // ── 3MB size limit ──
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File size exceeds the 3MB limit. Your file is ${(file.size / (1024 * 1024)).toFixed(1)}MB.`,
      );
    }

    // ── MIME type validation ──
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        `Invalid file type: ${file.mimetype}. Allowed types: JPEG, PNG, WebP.`,
      );
    }

    if (!hasAllowedImageSignature(file)) {
      throw new BadRequestException('The uploaded file does not match a supported image format.');
    }

    const ext = EXTENSION_BY_MIME[file.mimetype] ?? 'jpg';
    const fileKey = `listings/${uuidv4()}.${ext}`;

    const uploadParams = {
      Bucket: this.bucketName,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'public, max-age=31536000, immutable',
      ContentDisposition: 'inline',
      ServerSideEncryption: 'AES256' as const,
    };

    try {
      await this.s3Client.send(new PutObjectCommand(uploadParams));
      return this.publicBaseUrl
        ? `${this.publicBaseUrl}/${fileKey}`
        : `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${fileKey}`;
    } catch (error: unknown) {
      console.error('[S3Service] File upload failed', error);
      throw new InternalServerErrorException('File upload failed. Please try again.');
    }
  }

  async deleteFile(fileKey: string): Promise<void> {
    try {
      await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: fileKey }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      throw new InternalServerErrorException(`File deletion failed: ${msg}`);
    }
  }

  async fileExists(fileKey: string): Promise<boolean> {
    try {
      await this.s3Client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: fileKey }));
      return true;
    } catch (error: unknown) {
      if ((error as { name: string }).name === 'NotFound') {
        return false;
      }
      const msg = error instanceof Error ? error.message : 'Unknown error';
      throw new InternalServerErrorException(`Error checking file existence: ${msg}`);
    }
  }
}
