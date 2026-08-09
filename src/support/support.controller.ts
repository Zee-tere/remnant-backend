import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CreateSupportRequestDto } from './support.dto';
import { SupportService } from './support.service';

@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  create(@Body() dto: CreateSupportRequestDto) {
    return this.supportService.create(dto);
  }
}
