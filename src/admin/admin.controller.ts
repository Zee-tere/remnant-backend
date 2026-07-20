import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import {
  AdminListingStatusDto,
  AdminMessageUserDto,
  AdminReportActionDto,
  AdminTransactionStatusDto,
  AdminUpdateUserDto,
  ResolveReportDto,
} from './admin.dto';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard')
  getDashboard() {
    return this.adminService.getDashboard();
  }

  @Get('users')
  getUsers(@Query('page') page?: string, @Query('limit') limit?: string, @Query('search') search?: string) {
    return this.adminService.getUsers(
      Math.max(Number(page) || 1, 1),
      Math.min(Math.max(Number(limit) || 20, 1), 100),
      search?.trim().slice(0, 100),
    );
  }

  @Patch('users/:id')
  updateUser(@Param('id') id: string, @Body() data: AdminUpdateUserDto, @Req() req: Request) {
    return this.adminService.updateUser(id, data, (req.user as { userId: string }).userId);
  }

  @Post('users/:id/message')
  messageUser(@Param('id') id: string, @Body() dto: AdminMessageUserDto) {
    return this.adminService.messageUser(id, dto.message);
  }

  @Get('listings')
  getListings(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.adminService.getListings(
      Math.max(Number(page) || 1, 1),
      Math.min(Math.max(Number(limit) || 20, 1), 100),
      search?.trim().slice(0, 100),
      status,
    );
  }

  @Get('listings/flagged')
  getFlaggedListings() {
    return this.adminService.getFlaggedListings();
  }

  @Patch('listings/:id')
  updateListingStatus(@Param('id') id: string, @Body() dto: AdminListingStatusDto) {
    return this.adminService.updateListingStatus(id, dto.status);
  }

  @Delete('listings/:id')
  removeListing(@Param('id') id: string) {
    return this.adminService.removeListing(id);
  }

  @Get('transactions')
  getTransactions(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.adminService.getAllTransactions(
      Math.max(Number(page) || 1, 1),
      Math.min(Math.max(Number(limit) || 20, 1), 100),
    );
  }

  @Post('transactions/:id/refund')
  refundTransaction(@Param('id') id: string, @Req() req: Request) {
    return this.adminService.refundTransaction(id, req.user!.userId);
  }

  @Patch('transactions/:id')
  overrideTransactionStatus(@Param('id') id: string, @Body() dto: AdminTransactionStatusDto) {
    return this.adminService.overrideTransactionStatus(id, dto.status);
  }

  @Get('reports')
  getReports(@Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string) {
    return this.adminService.getReports(
      Math.max(Number(page) || 1, 1),
      Math.min(Math.max(Number(limit) || 20, 1), 100),
      status,
    );
  }

  @Post('reports/:id/action')
  actOnReport(@Param('id') id: string, @Body() dto: AdminReportActionDto) {
    return this.adminService.actOnReport(id, dto);
  }

  @Patch('reports/:id')
  resolveReport(@Param('id') id: string, @Body() dto: ResolveReportDto) {
    return this.adminService.resolveReport(id, dto.resolution);
  }
}
