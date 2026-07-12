import { Controller, Get, Patch, Param, Body, Req, UseGuards } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';

@Controller('matches')
export class MatchingController {
  constructor(private readonly matchingService: MatchingService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async getMatches(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.matchingService.getMatchesForUser(user.sub);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async updateMatchStatus(
    @Param('id') id: string,
    @Body('status') status: 'VIEWED' | 'DISMISSED',
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.matchingService.updateMatchStatus(id, user.sub, status);
  }
}
