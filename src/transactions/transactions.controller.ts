import { Controller, Get, Post, Patch, Param, Body, Req, UseGuards, Headers, ForbiddenException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';

@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async initiate(@Body('listingId') listingId: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.transactionsService.initiateTransaction(user.sub, listingId);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async getUserTransactions(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.transactionsService.getUserTransactions(user.sub);
  }

  @Post('webhooks/escrow')
  async escrowWebhook(
    @Body() body: Record<string, unknown>,
    @Headers('x-remnant-webhook-secret') webhookSecret?: string,
  ) {
    if (this.configService.get<string>('ESCROW_ENABLED', 'false') !== 'true') {
      return { received: true, note: 'escrow disabled' };
    }

    const expectedSecret = this.configService.get<string>('ESCROW_WEBHOOK_SECRET');
    if (expectedSecret && webhookSecret !== expectedSecret) {
      throw new ForbiddenException('Invalid webhook secret');
    }
    return this.transactionsService.handleEscrowWebhook(body);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getTransaction(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.transactionsService.getTransaction(id, user.sub);
  }

  @Patch(':id/ship')
  @UseGuards(JwtAuthGuard)
  async markShipped(
    @Param('id') id: string,
    @Body('trackingInfo') trackingInfo: string,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.transactionsService.markShipped(id, user.sub, trackingInfo);
  }

  @Post(':id/stub-fund')
  @UseGuards(JwtAuthGuard)
  async fundStubTransaction(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.transactionsService.fundStubTransaction(id, user.sub);
  }

  @Patch(':id/confirm')
  @UseGuards(JwtAuthGuard)
  async confirmReceipt(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.transactionsService.confirmReceipt(id, user.sub);
  }

  @Post(':id/dispute')
  @UseGuards(JwtAuthGuard)
  async dispute(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.transactionsService.disputeTransaction(id, user.sub);
  }
}
