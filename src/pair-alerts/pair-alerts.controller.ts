import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PairAlertsService } from './pair-alerts.service';
import { CreatePairAlertDto, UpdatePairAlertDto, UpdatePairAlertMatchDto } from './pair-alerts.dto';

@Controller('pair-alerts')
@UseGuards(JwtAuthGuard)
export class PairAlertsController {
  constructor(private readonly pairAlertsService: PairAlertsService) {}

  @Post()
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
  update(@Param('id') id: string, @Body() dto: UpdatePairAlertDto, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.pairAlertsService.update(id, user.sub, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.pairAlertsService.remove(id, user.sub);
  }

  @Patch('matches/:id')
  updateMatch(@Param('id') id: string, @Body() dto: UpdatePairAlertMatchDto, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.pairAlertsService.updateMatchStatus(id, user.sub, dto.status);
  }
}
