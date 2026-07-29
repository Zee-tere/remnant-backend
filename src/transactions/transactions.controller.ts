import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  InitiateGuestTransactionDto,
  InitiateTransactionDto,
  MarkShippedDto,
} from './transactions.dto';
import { PaystackService } from './paystack.service';
import { TransactionsService } from './transactions.service';

function secretsMatch(received: string | undefined, expected: string | undefined) {
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService,
    private readonly paystackService: PaystackService,
  ) {}

  @Get('config')
  getPaymentConfig() {
    return this.transactionsService.getPaymentConfig();
  }

  @Post('guest')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  initiateGuest(@Body() dto: InitiateGuestTransactionDto) {
    return this.transactionsService.initiateGuestTransaction(dto);
  }

  @Get('guest/:id')
  getGuestTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-guest-token') token?: string,
  ) {
    return this.transactionsService.getGuestTransaction(id, token);
  }

  @Patch('guest/:id/confirm')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  confirmGuestReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-guest-token') token?: string,
  ) {
    return this.transactionsService.confirmGuestReceipt(id, token);
  }

  @Post('guest/:id/dispute')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  disputeGuestTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-guest-token') token?: string,
  ) {
    return this.transactionsService.disputeGuestTransaction(id, token);
  }

  @Get('paystack/verify/:reference')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  verifyPaystack(@Param('reference') reference: string) {
    return this.transactionsService.verifyPaystackTransaction(reference);
  }

  @Post('paystack/webhook')
  async paystackWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('x-paystack-signature') signature?: string,
  ) {
    if (
      !req.rawBody ||
      !this.paystackService.verifyWebhookSignature(req.rawBody, signature)
    ) {
      throw new ForbiddenException('Invalid Paystack webhook signature');
    }
    return this.transactionsService.handlePaystackWebhook(body);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async initiate(@Body() dto: InitiateTransactionDto, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.transactionsService.initiateTransaction(
      user.sub,
      dto.listingId,
    );
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

    const expectedSecret = this.configService.get<string>(
      'ESCROW_WEBHOOK_SECRET',
    );
    if (!secretsMatch(webhookSecret, expectedSecret)) {
      throw new ForbiddenException('Invalid webhook secret');
    }
    return this.transactionsService.handleEscrowWebhook(body);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.transactionsService.getTransaction(id, user.sub);
  }

  @Patch(':id/ship')
  @UseGuards(JwtAuthGuard)
  async markShipped(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkShippedDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.transactionsService.markShipped(id, user.sub, dto.trackingInfo);
  }

  @Post(':id/stub-fund')
  @UseGuards(JwtAuthGuard)
  async fundStubTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.transactionsService.fundStubTransaction(id, user.sub);
  }

  @Patch(':id/confirm')
  @UseGuards(JwtAuthGuard)
  async confirmReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.transactionsService.confirmReceipt(id, user.sub);
  }

  @Post(':id/dispute')
  @UseGuards(JwtAuthGuard)
  async dispute(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.transactionsService.disputeTransaction(id, user.sub);
  }
}
