import { ForbiddenException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    listing: { findUnique: jest.fn(), update: jest.fn() },
  };
  const notifications = { createNotification: jest.fn() };
  const service = new AdminService(prisma as never, {} as never, notifications as never);

  beforeEach(() => jest.clearAllMocks());

  it('prevents an administrator from demoting their own account', async () => {
    await expect(service.updateUser('admin-1', { role: 'USER' }, 'admin-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('removes a listing reversibly by pausing it', async () => {
    prisma.listing.findUnique.mockResolvedValue({ id: 'listing-1' });
    prisma.listing.update.mockResolvedValue({ id: 'listing-1', status: 'PAUSED' });

    await expect(service.removeListing('listing-1')).resolves.toEqual({
      message: 'Listing removed from the public marketplace',
    });
    expect(prisma.listing.update).toHaveBeenCalledWith({
      where: { id: 'listing-1' },
      data: { status: 'PAUSED' },
    });
  });
});
