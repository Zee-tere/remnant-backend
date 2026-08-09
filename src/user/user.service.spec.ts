import { UserService } from './user.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UserService', () => {
  it.each([
    { isPublicProfile: false, showStateOnProfile: false, expectedCity: undefined },
    { isPublicProfile: true, showStateOnProfile: false, expectedCity: null },
    { isPublicProfile: true, showStateOnProfile: true, expectedCity: 'Lagos' },
  ])('enforces persisted public profile settings: %o', async ({ isPublicProfile, showStateOnProfile, expectedCity }) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          name: 'Ada',
          avatarUrl: null,
          bio: 'Repair enthusiast',
          city: 'Lagos',
          trustTier: 'NEW',
          points: 0,
          createdAt: new Date(),
          isPublicProfile,
          showStateOnProfile,
          _count: { listings: 1, reviewsReceived: 0 },
        }),
      },
    };
    const service = new UserService(prisma as unknown as PrismaService);

    if (!isPublicProfile) {
      await expect(service.getUserById('user-1')).rejects.toThrow('User not found');
      return;
    }

    const result = await service.getUserById('user-1');
    expect(result).not.toHaveProperty('isPublicProfile');
    expect(result).not.toHaveProperty('showStateOnProfile');
    expect(result.city).toBe(expectedCity);
  });

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
