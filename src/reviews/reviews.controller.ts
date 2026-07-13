import { Controller, Post, Get, Param, Body, Req, UseGuards } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { SubmitReviewDto } from './reviews.dto';

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async submitReview(
    @Body() body: SubmitReviewDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.reviewsService.submitReview(user.sub, body.transactionId, body.rating, body.comment);
  }
}
