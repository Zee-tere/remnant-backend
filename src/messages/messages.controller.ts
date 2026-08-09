import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CreateMessageDto,
  GetConversationsQueryDto,
  GetMessagesQueryDto,
  MarkConversationReadDto,
  StartConversationDto,
  StartGuestConversationDto,
} from './messages.dto';
import { MessagesService } from './messages.service';

@Controller('conversations')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('guest')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  startGuestConversation(
    @Body() dto: StartGuestConversationDto,
  ) {
    return this.messagesService.startGuestConversation(dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async getConversations(
    @Req() req: Request,
    @Query() query: GetConversationsQueryDto,
  ) {
    const user = req.user as { sub: string };
    return this.messagesService.getConversations(user.sub, query);
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
  async getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Query() query: GetMessagesQueryDto,
  ) {
    const user = req.user as { sub: string };
    return this.messagesService.getMessages(id, user.sub, query);
  }

  @Post(':id/messages')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async createMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMessageDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.messagesService.createMessage(
      id,
      user.sub,
      dto.content,
      dto.type,
      dto.clientMessageId,
    );
  }

  @Patch(':id/read')
  @UseGuards(JwtAuthGuard)
  async markAsRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() dto: MarkConversationReadDto = {},
  ) {
    const user = req.user as { sub: string };
    return this.messagesService.markAsRead(id, user.sub, dto);
  }
}
