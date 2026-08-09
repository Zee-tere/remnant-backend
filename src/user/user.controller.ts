import { Controller, Delete, Get, Headers, Put, Param, Body, Req, UseGuards } from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { UpdateUserDto } from './user.dto';
import { GuestAccessService } from '../auth/guest-access.service';

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly guestAccessService: GuestAccessService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.userService.getUserById(user.sub, true);
  }

  @Get('me/summary')
  @UseGuards(JwtAuthGuard)
  async getMySummary(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.userService.getDashboardSummary(user.sub);
  }

  @Put('me')
  @UseGuards(JwtAuthGuard)
  async updateMe(
    @Req() req: Request,
    @Body() data: UpdateUserDto,
  ) {
    const user = req.user as { sub: string };
    return this.userService.updateUser(user.sub, data);
  }

  @Get('me/achievements')
  @UseGuards(JwtAuthGuard)
  async getMyAchievements(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.userService.getAchievements(user.sub);
  }

  @Get('me/export')
  @UseGuards(JwtAuthGuard)
  exportMyData(@Req() req: Request) {
    return this.userService.exportUserData(req.user!.userId);
  }

  @Delete('me')
  @UseGuards(JwtAuthGuard)
  requestMyDeletion(@Req() req: Request) {
    return this.userService.requestDeletion(req.user!.userId);
  }

  @Delete('guest/me')
  requestGuestDeletion(@Headers('x-guest-token') token?: string) {
    const guest = this.guestAccessService.verifyIdentityToken(token);
    return this.userService.requestDeletion(guest.userId);
  }

  @Get(':id')
  async getUser(@Param('id') id: string) {
    return this.userService.getUserById(id);
  }

  @Get(':id/reviews')
  async getUserReviews(@Param('id') id: string) {
    return this.userService.getUserReviews(id);
  }
}
