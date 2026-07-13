import { Injectable, InternalServerErrorException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
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
      throw new ServiceUnavailableException('Image uploads are not configured yet. Please try again shortly.');
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
      const maybeError = error as { name?: string; '$metadata'?: { httpStatusCode?: number } };
      const name = maybeError.name;
      const statusCode = maybeError.$metadata?.httpStatusCode;
      if (name === 'AccessDenied' || name === 'NoSuchBucket' || name === 'PermanentRedirect' || statusCode === 403) {
        throw new ServiceUnavailableException('Image uploads are not ready yet. Please check the upload bucket settings.');
      }
      throw new InternalServerErrorException('File upload failed. Please try again.');
    }
  }

  async getUploadStatus() {
    if (!this.bucketName) {
      return {
        configured: false,
        bucket: null,
        region: this.region,
        publicBaseUrlConfigured: Boolean(this.publicBaseUrl),
        bucketReachable: false,
        message: 'AWS_S3_BUCKET is not set on Lambda.',
      };
    }

    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      return {
        configured: true,
        bucket: this.bucketName,
        region: this.region,
        publicBaseUrlConfigured: Boolean(this.publicBaseUrl),
        bucketReachable: true,
        message: 'Upload bucket is configured and reachable from Lambda.',
      };
    } catch (error: unknown) {
      const maybeError = error as { name?: string; message?: string; '$metadata'?: { httpStatusCode?: number } };
      return {
        configured: true,
        bucket: this.bucketName,
        region: this.region,
        publicBaseUrlConfigured: Boolean(this.publicBaseUrl),
        bucketReachable: false,
        errorName: maybeError.name ?? 'UnknownError',
        statusCode: maybeError.$metadata?.httpStatusCode ?? null,
        message:
          maybeError.name === 'AccessDenied' || maybeError.$metadata?.httpStatusCode === 403
            ? 'Lambda can see the bucket name but remnant-lambda-role needs bucket-level S3 permission such as s3:ListBucket and s3:GetBucketLocation.'
            : 'Lambda cannot reach the upload bucket. Check AWS_S3_BUCKET, AWS_REGION, bucket existence, and role permissions.',
      };
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
