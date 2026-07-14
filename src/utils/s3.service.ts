import { Injectable, InternalServerErrorException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
  private credentialMode: 'default-provider' | 'env-static' | 'env-session';
  private readonly readableUrlCache = new Map<string, { url: string; refreshAt: number }>();

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET')?.trim() ?? '';
    this.region = this.configService.get<string>('AWS_REGION', 'us-east-1')!;
    this.publicBaseUrl = this.configService.get<string>('AWS_S3_PUBLIC_BASE_URL')?.replace(/\/$/, '');

    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
    const sessionToken = this.configService.get<string>('AWS_SESSION_TOKEN');
    this.credentialMode = accessKeyId && secretAccessKey ? (sessionToken ? 'env-session' : 'env-static') : 'default-provider';

    this.s3Client = new S3Client({
      region: this.region,
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
              ...(sessionToken ? { sessionToken } : {}),
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
    const includeDiagnostics = this.configService.get<string>('NODE_ENV') === 'development';

    if (!this.bucketName) {
      return includeDiagnostics
        ? {
            available: false,
            configured: false,
            bucket: null,
            region: this.region,
            publicBaseUrlConfigured: Boolean(this.publicBaseUrl),
            credentialMode: this.credentialMode,
            message: 'AWS_S3_BUCKET is not set.',
          }
        : { available: false, message: 'Image uploads are temporarily unavailable.' };
    }

    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      return includeDiagnostics
        ? {
            available: true,
            configured: true,
            bucket: this.bucketName,
            region: this.region,
            publicBaseUrlConfigured: Boolean(this.publicBaseUrl),
            credentialMode: this.credentialMode,
          }
        : { available: true };
    } catch (error: unknown) {
      const maybeError = error as { name?: string; message?: string; '$metadata'?: { httpStatusCode?: number } };
      return includeDiagnostics
        ? {
            available: false,
            configured: true,
            bucket: this.bucketName,
            region: this.region,
            publicBaseUrlConfigured: Boolean(this.publicBaseUrl),
            credentialMode: this.credentialMode,
            errorName: maybeError.name ?? 'UnknownError',
            statusCode: maybeError.$metadata?.httpStatusCode ?? null,
          }
        : { available: false, message: 'Image uploads are temporarily unavailable.' };
    }
  }

  async getReadableUrl(storedUrl: string): Promise<string> {
    if (!storedUrl || this.publicBaseUrl || storedUrl.startsWith('data:') || storedUrl.startsWith('blob:')) {
      return storedUrl;
    }

    const key = this.getObjectKey(storedUrl);
    if (!key || !this.bucketName) return storedUrl;

    const cached = this.readableUrlCache.get(key);
    if (cached && cached.refreshAt > Date.now()) return cached.url;

    const url = await getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      { expiresIn: 3600 },
    );
    if (this.readableUrlCache.size >= 1000) this.readableUrlCache.clear();
    this.readableUrlCache.set(key, { url, refreshAt: Date.now() + 50 * 60 * 1000 });
    return url;
  }

  async getReadableUrls(storedUrls: string[]): Promise<string[]> {
    return Promise.all(storedUrls.map((url) => this.getReadableUrl(url)));
  }

  getObjectKey(storedUrl: string): string | null {
    try {
      const url = new URL(storedUrl);
      const expectedHosts = new Set([
        `${this.bucketName}.s3.${this.region}.amazonaws.com`,
        `${this.bucketName}.s3.amazonaws.com`,
      ]);
      if (!expectedHosts.has(url.hostname)) return null;
      const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
      return key.startsWith('listings/') ? key : null;
    } catch {
      return storedUrl.startsWith('listings/') ? storedUrl : null;
    }
  }

  async deleteFile(fileKey: string): Promise<void> {
    try {
      await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: fileKey }));
    } catch (error: unknown) {
      console.error('[S3Service] File deletion failed', {
        name: error instanceof Error ? error.name : 'unknown',
      });
      throw new InternalServerErrorException('File deletion failed. Please try again.');
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
      console.error('[S3Service] File existence check failed', {
        name: error instanceof Error ? error.name : 'unknown',
      });
      throw new InternalServerErrorException('Could not verify the uploaded file. Please try again.');
    }
  }
}
