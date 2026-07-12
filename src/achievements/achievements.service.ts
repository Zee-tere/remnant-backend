import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface AchievementDef {
  key: string;
  name: string;
  description: string;
  points: number;
  check: (stats: UserStats) => boolean;
}

interface UserStats {
  totalListings: number;
  completedSellTx: number;
  completedDonateTx: number;
  completedFixTx: number;
  completedRecycleTx: number;
  completedMatchTx: number;
}

const ACHIEVEMENTS: AchievementDef[] = [
  { key: 'FIRST_DROP', name: 'First Drop', description: 'Created your first listing', points: 10, check: (s) => s.totalListings >= 1 },
  { key: 'PERFECT_PAIR', name: 'Perfect Pair', description: 'Completed your first matched transaction', points: 50, check: (s) => s.completedMatchTx >= 1 },
  { key: 'GOOD_SAMARITAN', name: 'Good Samaritan', description: 'Completed 3 donations', points: 30, check: (s) => s.completedDonateTx >= 3 },
  { key: 'FIXER_UPPER', name: 'Fixer Upper', description: 'Connected with a repairer', points: 25, check: (s) => s.completedFixTx >= 1 },
  { key: 'POWER_SELLER', name: 'Power Seller', description: 'Completed 25 sales', points: 100, check: (s) => s.completedSellTx >= 25 },
  { key: 'ZERO_WASTE', name: 'Zero Waste Hero', description: '10 donate or recycle completions', points: 75, check: (s) => (s.completedDonateTx + s.completedRecycleTx) >= 10 },
];

@Injectable()
export class AchievementsService {
  constructor(private prisma: PrismaService) {}

  async checkAndAward(userId: string) {
    const stats = await this.getUserStats(userId);
    const existing = await this.prisma.userAchievement.findMany({
      where: { userId },
      select: { achievementKey: true },
    });
    const existingKeys = new Set(existing.map((a) => a.achievementKey));

    const newAchievements: string[] = [];

    for (const achievement of ACHIEVEMENTS) {
      if (!existingKeys.has(achievement.key) && achievement.check(stats)) {
        await this.prisma.userAchievement.create({
          data: { userId, achievementKey: achievement.key },
        });
        await this.prisma.user.update({
          where: { id: userId },
          data: { points: { increment: achievement.points } },
        });
        newAchievements.push(achievement.key);
      }
    }

    return newAchievements;
  }

  private async getUserStats(userId: string): Promise<UserStats> {
    const [totalListings, completedSellTx, completedDonateTx, completedFixTx, completedRecycleTx, completedMatchTx] =
      await Promise.all([
        this.prisma.listing.count({ where: { userId } }),
        this.prisma.transaction.count({
          where: { sellerId: userId, status: 'COMPLETE', listing: { intentionTag: 'SELL' } },
        }),
        this.prisma.transaction.count({
          where: { sellerId: userId, status: 'COMPLETE', listing: { intentionTag: 'DONATE' } },
        }),
        this.prisma.transaction.count({
          where: { sellerId: userId, status: 'COMPLETE', listing: { intentionTag: 'FIX' } },
        }),
        this.prisma.transaction.count({
          where: { sellerId: userId, status: 'COMPLETE', listing: { intentionTag: 'RECYCLE' } },
        }),
        this.prisma.match.count({
          where: { status: 'COMPLETED', OR: [{ listingA: { userId } }, { listingB: { userId } }] },
        }),
      ]);

    return { totalListings, completedSellTx, completedDonateTx, completedFixTx, completedRecycleTx, completedMatchTx };
  }

  getAchievementDefinitions() {
    return ACHIEVEMENTS.map(({ key, name, description, points }) => ({ key, name, description, points }));
  }
}
