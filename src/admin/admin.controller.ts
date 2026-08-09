import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import {
  AdminListingStatusDto,
  AdminMessageUserDto,
  AdminReportActionDto,
  AdminUpdateUserDto,
  ResolveReportDto,
  ResolveSupportRequestDto,
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
  updateUser(@Param('id', ParseUUIDPipe) id: string, @Body() data: AdminUpdateUserDto, @Req() req: Request) {
    return this.adminService.updateUser(id, data, (req.user as { userId: string }).userId);
  }

  @Post('users/:id/message')
  messageUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminMessageUserDto) {
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
  updateListingStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminListingStatusDto) {
    return this.adminService.updateListingStatus(id, dto.status);
  }

  @Delete('listings/:id')
  removeListing(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.removeListing(id);
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
  actOnReport(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminReportActionDto) {
    return this.adminService.actOnReport(id, dto);
  }

  @Patch('reports/:id')
  resolveReport(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveReportDto) {
    return this.adminService.resolveReport(id, dto.resolution);
  }

  @Get('support')
  getSupportRequests(@Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string) {
    return this.adminService.getSupportRequests(
      Math.max(Number(page) || 1, 1),
      Math.min(Math.max(Number(limit) || 20, 1), 100),
      status,
    );
  }

  @Patch('support/:id')
  updateSupportRequest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveSupportRequestDto) {
    return this.adminService.updateSupportRequest(id, dto);
  }
}
