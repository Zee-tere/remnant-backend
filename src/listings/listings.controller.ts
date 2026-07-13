import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ListingsService } from './listings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateListingDto, UpdateListingDto } from './listings.dto';
import { Request } from 'express';

@Controller('listings')
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) { }

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Body() dto: CreateListingDto, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.listingsService.create(user.sub, dto);
  }

  @Post('guest')
  @Throttle({ default: { limit: 4, ttl: 60000 } })
  async createGuest(@Body() dto: CreateListingDto) {
    return this.listingsService.createGuest(dto);
  }

  @Get()
  async findAll(
    @Query('category') category?: string,
    @Query('intentionTag') intentionTag?: string,
    @Query('city') city?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.listingsService.findAll({
      category,
      intentionTag,
      city,
      search,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('search')
  async search(
    @Query('q') query: string,
    @Query('category') category?: string,
    @Query('city') city?: string,
    @Query('intent') intent?: string,
    @Query('limit') limit?: string,
  ) {
    return this.listingsService.semanticSearch({
      query,
      category,
      city,
      intent,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('saved')
  @UseGuards(JwtAuthGuard)
  async getSavedListings(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.listingsService.getSavedListings(user.sub);
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  async getMyListings(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.listingsService.findByUser(user.sub);
  }

  @Get('slug/:slug')
  async findBySlug(@Param('slug') slug: string) {
    return this.listingsService.findBySlug(slug);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.listingsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.listingsService.update(id, user.sub, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.listingsService.remove(id, user.sub);
  }

  @Post(':id/save')
  @UseGuards(JwtAuthGuard)
  async saveListing(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.listingsService.saveListing(user.sub, id);
  }

  @Delete(':id/save')
  @UseGuards(JwtAuthGuard)
  async unsaveListing(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.listingsService.unsaveListing(user.sub, id);
  }
}
