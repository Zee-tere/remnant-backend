import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';

@Controller('conversations')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async getConversations(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.messagesService.getConversations(user.sub);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async startConversation(
    @Body('listingId') listingId: string,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.messagesService.startConversation(user.sub, listingId);
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
    @Body('content') content: string,
    @Body('type') type: 'TEXT' | 'IMAGE' | 'OFFER' | 'SYSTEM' | undefined,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.messagesService.createMessage(id, user.sub, content, type ?? 'TEXT');
  }

  @Patch(':id/read')
  @UseGuards(JwtAuthGuard)
  async markAsRead(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.messagesService.markAsRead(id, user.sub);
  }
}
