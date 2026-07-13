import { Controller, Get, Put, Param, Body, Req, UseGuards } from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { UpdateUserDto } from './user.dto';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.userService.getUserById(user.sub, true);
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

  @Get(':id')
  async getUser(@Param('id') id: string) {
    return this.userService.getUserById(id);
  }

  @Get(':id/reviews')
  async getUserReviews(@Param('id') id: string) {
    return this.userService.getUserReviews(id);
  }
}
