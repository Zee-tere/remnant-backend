import {
  Controller,
  Get,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  UseGuards,
  BadRequestException,
  Headers,
  Req,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { S3Service } from '../utils/s3.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { GuestAccessService } from '../auth/guest-access.service';
import { UploadService } from './upload.service';

const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3MB
const MAX_MEMBER_FILES = 8;
const MAX_GUEST_FILES = 4;

@Controller('upload')
export class UploadController {
  constructor(
    private readonly s3Service: S3Service,
    private readonly uploadService: UploadService,
    private readonly guestAccessService: GuestAccessService,
  ) {}

  @Get('status')
  async uploadStatus() {
    return this.s3Service.getUploadStatus();
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadFile(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const user = req.user as { sub: string };
    const upload = await this.uploadService.uploadForOwner(user.sub, file);
    return { url: upload.url, uploadId: upload.id };
  }

  @Post('guest')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadGuestFile(
    @UploadedFile() file: Express.Multer.File,
    @Headers('x-guest-token') token?: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const guest = this.guestAccessService.verifyIdentityToken(token);
    const upload = await this.uploadService.uploadForOwner(guest.userId, file);
    return { url: upload.url, uploadId: upload.id };
  }

  @Post('multiple')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FilesInterceptor('files', MAX_MEMBER_FILES, {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadMultipleFiles(@UploadedFiles() files: Express.Multer.File[], @Req() req: Request) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }

    const user = req.user as { sub: string };
    const uploads = await Promise.all(files.map((file) => this.uploadService.uploadForOwner(user.sub, file)));
    return { urls: uploads.map((upload) => upload.url), uploadIds: uploads.map((upload) => upload.id) };
  }

  @Post('guest/multiple')
  @Throttle({ default: { limit: 4, ttl: 60000 } })
  @UseInterceptors(
    FilesInterceptor('files', MAX_GUEST_FILES, {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadGuestMultipleFiles(
    @UploadedFiles() files: Express.Multer.File[],
    @Headers('x-guest-token') token?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }
    if (files.length > MAX_GUEST_FILES) {
      throw new BadRequestException(`Guest uploads are limited to ${MAX_GUEST_FILES} files at a time`);
    }

    const guest = this.guestAccessService.verifyIdentityToken(token);
    const uploads = await Promise.all(files.map((file) => this.uploadService.uploadForOwner(guest.userId, file)));
    return { urls: uploads.map((upload) => upload.url), uploadIds: uploads.map((upload) => upload.id) };
  }
}
