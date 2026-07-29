import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PairAlertsService } from './pair-alerts.service';
import { CreatePairAlertDto, UpdatePairAlertDto, UpdatePairAlertMatchDto } from './pair-alerts.dto';

@Controller('pair-alerts')
@UseGuards(JwtAuthGuard)
export class PairAlertsController {
  constructor(private readonly pairAlertsService: PairAlertsService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  create(@Body() dto: CreatePairAlertDto, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.pairAlertsService.create(user.sub, dto);
  }

  @Get()
  @Header('Cache-Control', 'no-store, max-age=0')
  findMine(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.pairAlertsService.findForUser(user.sub);
  }

  @Patch(':id')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePairAlertDto, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.pairAlertsService.update(id, user.sub, dto);
  }

  @Delete(':id')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.pairAlertsService.remove(id, user.sub);
  }

  @Patch('matches/:id')
  updateMatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePairAlertMatchDto, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.pairAlertsService.updateMatchStatus(id, user.sub, dto.status);
  }
}
