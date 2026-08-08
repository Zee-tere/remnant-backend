import { UserService } from './user.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UserService', () => {
  it('returns dashboard counts without loading full records', async () => {
    const prisma = {
      listing: {
        count: jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(3),
      },
      notification: { count: jest.fn().mockResolvedValue(2) },
      match: { count: jest.fn().mockResolvedValue(1) },
      pairAlertMatch: { count: jest.fn().mockResolvedValue(2) },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 2 }]),
    };
    const service = new UserService(prisma as unknown as PrismaService);

    await expect(service.getDashboardSummary('user-1')).resolves.toEqual({
      listings: 4,
      activeListings: 3,
      unreadAlerts: 2,
      pendingMatches: 3,
      unreadMessages: 2,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', type: 'PAIR_MATCH', isRead: false },
    });
  });
});
