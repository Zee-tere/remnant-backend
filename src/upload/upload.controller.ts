import {
  Controller,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { S3Service } from '../utils/s3.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3MB
const MAX_MEMBER_FILES = 8;
const MAX_GUEST_FILES = 4;

@Controller('upload')
export class UploadController {
  constructor(private readonly s3Service: S3Service) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const url = await this.s3Service.uploadFile(file);
    return { url };
  }

  @Post('guest')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadGuestFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const url = await this.s3Service.uploadFile(file);
    return { url };
  }

  @Post('multiple')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FilesInterceptor('files', MAX_MEMBER_FILES, {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadMultipleFiles(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }

    const urls: string[] = [];
    for (const file of files) {
      const url = await this.s3Service.uploadFile(file);
      urls.push(url);
    }

    return { urls };
  }

  @Post('guest/multiple')
  @Throttle({ default: { limit: 4, ttl: 60000 } })
  @UseInterceptors(
    FilesInterceptor('files', MAX_GUEST_FILES, {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadGuestMultipleFiles(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }
    if (files.length > MAX_GUEST_FILES) {
      throw new BadRequestException(`Guest uploads are limited to ${MAX_GUEST_FILES} files at a time`);
    }

    const urls: string[] = [];
    for (const file of files) {
      const url = await this.s3Service.uploadFile(file);
      urls.push(url);
    }

    return { urls };
  }
}
