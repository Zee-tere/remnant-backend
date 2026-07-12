import { Controller, Get, Patch, Param, Body, Query, UseGuards, Post, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { Request } from 'express';
import { TransactionStatus } from '@prisma/client';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) { }

  @Get('dashboard')
  async getDashboard() {
    return this.adminService.getDashboard();
  }

  @Get('users')
  async getUsers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 100) : 20; // ✅ Max 100
    return this.adminService.getUsers(
      page ? parseInt(page, 10) : 1,
      parsedLimit,
      search,
    );
  }

  @Patch('users/:id')
  async updateUser(
    @Param('id') id: string,
    @Body() data: { role?: 'USER' | 'MODERATOR' | 'ADMIN'; bannedAt?: Date | null },
  ) {
    return this.adminService.updateUser(id, data);
  }

  @Get('listings/flagged')
  async getFlaggedListings() {
    return this.adminService.getFlaggedListings();
  }

  @Patch('listings/:id')
  async updateListingStatus(
    @Param('id') id: string,
    @Body('status') status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'EXPIRED' | 'FLAGGED',
  ) {
    return this.adminService.updateListingStatus(id, status);
  }

  @Get('transactions')
  async getTransactions(@Query('page') page?: string, @Query('limit') limit?: string) {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 100) : 20; // ✅ Max 100
    return this.adminService.getAllTransactions(
      page ? parseInt(page, 10) : 1,
      parsedLimit,
    );
  }

  @Post('transactions/:id/refund')
  async refundTransaction(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.adminService.refundTransaction(id, user.sub);
  }

  @Patch('transactions/:id')
  async overrideTransactionStatus(@Param('id') id: string, @Body('status') status: TransactionStatus) {
    return this.adminService.overrideTransactionStatus(id, status);
  }

  @Get('reports')
  async getReports(@Query('page') page?: string, @Query('limit') limit?: string) {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 100) : 20; // ✅ Max 100
    return this.adminService.getReports(
      page ? parseInt(page, 10) : 1,
      parsedLimit,
    );
  }

  @Patch('reports/:id')
  async resolveReport(@Param('id') id: string, @Body('resolution') resolution: string) {
    return this.adminService.resolveReport(id, resolution);
  }
}
