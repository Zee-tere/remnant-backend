import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CreateMessageDto,
  StartConversationDto,
  StartGuestConversationDto,
} from './messages.dto';
import { MessagesService } from './messages.service';

@Controller('conversations')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('guest')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  startGuestConversation(@Body() dto: StartGuestConversationDto) {
    return this.messagesService.startGuestConversation(dto);
  }

  @Get('guest/:id')
  getGuestConversation(
    @Param('id') id: string,
    @Headers('x-guest-token') token?: string,
  ) {
    return this.messagesService.getGuestConversation(id, token);
  }

  @Post('guest/:id/messages')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  createGuestMessage(
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
    @Headers('x-guest-token') token?: string,
  ) {
    return this.messagesService.createGuestMessage(
      id,
      token,
      dto.content,
      dto.type,
    );
  }

  @Patch('guest/:id/read')
  markGuestConversationRead(
    @Param('id') id: string,
    @Headers('x-guest-token') token?: string,
  ) {
    return this.messagesService.markGuestConversationRead(id, token);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async getConversations(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.messagesService.getConversations(user.sub);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async startConversation(
    @Body() dto: StartConversationDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.messagesService.startConversation(user.sub, dto.listingId);
  }

  @Get(':id/messages')
  @UseGuards(JwtAuthGuard)
  async getMessages(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.messagesService.getMessages(id, user.sub);
  }

  @Post(':id/messages')
  @UseGuards(JwtAuthGuard)
  async createMessage(
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.messagesService.createMessage(
      id,
      user.sub,
      dto.content,
      dto.type,
    );
  }

  @Patch(':id/read')
  @UseGuards(JwtAuthGuard)
  async markAsRead(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.messagesService.markAsRead(id, user.sub);
  }
}
