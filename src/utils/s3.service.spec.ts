import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { S3Service } from './s3.service';

describe('S3Service', () => {
  const image = {
    buffer: Buffer.from('RIFF0000WEBP', 'ascii'),
    mimetype: 'image/webp',
    size: 12,
  } as Express.Multer.File;

  function createService() {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'AWS_S3_BUCKET') return 'remnant-uploads-prod';
        if (key === 'AWS_REGION') return 'us-east-1';
        return fallback;
      }),
    } as unknown as ConfigService;
    return new S3Service(config);
  }

  it('keeps a successful image upload when optional lifecycle tagging fails', async () => {
    const service = createService();
    const send = jest.fn((command: unknown) => {
      if (command instanceof PutObjectTaggingCommand) return Promise.reject(new Error('AccessDenied'));
      if (command instanceof PutObjectCommand) return Promise.resolve({});
      return Promise.resolve({});
    });
    (service as unknown as { s3Client: { send: typeof send } }).s3Client = { send };
    jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn').mockImplementation();

    await expect(service.uploadFile(image)).resolves.toMatch(/^https:\/\/remnant-uploads-prod\.s3\.us-east-1\.amazonaws\.com\/listings\/.+\.webp$/);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
