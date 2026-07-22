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
      conversation: { count: jest.fn().mockResolvedValue(2) },
    };
    const service = new UserService(prisma as unknown as PrismaService);

    await expect(service.getDashboardSummary('user-1')).resolves.toEqual({
      listings: 4,
      activeListings: 3,
      unreadAlerts: 2,
      pendingMatches: 1,
      unreadMessages: 2,
    });
    expect(prisma.conversation.count).toHaveBeenCalledWith({
      where: {
        OR: [{ buyerId: 'user-1' }, { sellerId: 'user-1' }],
        messages: { some: { senderId: { not: 'user-1' }, readAt: null } },
      },
    });
  });
});
