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
import { CreateMessageDto, StartConversationDto } from './messages.dto';

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
    return this.messagesService.createMessage(id, user.sub, dto.content, dto.type);
  }

  @Patch(':id/read')
  @UseGuards(JwtAuthGuard)
  async markAsRead(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.messagesService.markAsRead(id, user.sub);
  }
}
