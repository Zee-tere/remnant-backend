import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSupportRequestDto } from './support.dto';

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSupportRequestDto) {
    const request = await this.prisma.supportRequest.create({ data: dto });
    return {
      id: request.id,
      message: 'Your request has been received. Keep this reference for follow-up.',
    };
  }
}
