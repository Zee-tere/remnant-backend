import {
  Controller,
  Post,
  Get,
  Header,
  Headers,
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
import { CreateGuestListingDto, CreateListingDto, UpdateListingDto } from './listings.dto';
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
  async createGuest(@Body() dto: CreateGuestListingDto) {
    return this.listingsService.createGuest(dto);
  }

  @Get()
  @Header('Cache-Control', 'no-store, max-age=0')
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
  @Header('Cache-Control', 'no-store, max-age=0')
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

  @Get('sitemap')
  @Header('Cache-Control', 'public, max-age=1800, stale-while-revalidate=1800')
  async getSitemapEntries() {
    return this.listingsService.getSitemapEntries();
  }

  @Get('saved')
  @Header('Cache-Control', 'no-store, max-age=0')
  @UseGuards(JwtAuthGuard)
  async getSavedListings(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.listingsService.getSavedListings(user.sub);
  }

  @Get('my')
  @Header('Cache-Control', 'no-store, max-age=0')
  @UseGuards(JwtAuthGuard)
  async getMyListings(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.listingsService.findByUser(user.sub);
  }

  @Get('slug/:slug')
  @Header('Cache-Control', 'no-store, max-age=0')
  async findBySlug(@Param('slug') slug: string, @Query('trackView') trackView?: string) {
    return this.listingsService.findBySlug(slug, trackView !== 'false');
  }

  @Get(':id/similar')
  @Header('Cache-Control', 'public, max-age=120, stale-while-revalidate=300')
  async findSimilar(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.listingsService.findSimilar(id, limit ? parseInt(limit, 10) : undefined);
  }

  @Get(':id/contact')
  @Header('Cache-Control', 'no-store, max-age=0')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async getGuestContact(@Param('id') id: string) {
    return this.listingsService.getGuestContact(id);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store, max-age=0')
  async findOne(@Param('id') id: string, @Query('trackView') trackView?: string) {
    return this.listingsService.findOne(id, trackView !== 'false');
  }

  @Post(':id/view')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async trackView(@Param('id') id: string, @Headers('user-agent') userAgent?: string) {
    return this.listingsService.trackView(id, userAgent || '');
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
