import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { S3Service } from '../utils/s3.service';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { UploadService } from './upload.service';

@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [UploadController],
  providers: [S3Service, UploadService],
  exports: [S3Service, UploadService],
})
export class UploadModule {}
