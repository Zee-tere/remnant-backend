import { MatchingJobsService } from './matching-jobs.service';

describe('MatchingJobsService', () => {
  it('processes the exact listing version and completes the durable job', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: 'job-1',
        entityType: 'Listing',
        entityId: 'listing-1',
        entityVersion: 3,
        reason: 'listing_updated',
        attempts: 1,
      }]),
      listing: {
        findUnique: jest.fn().mockResolvedValue({
          version: 3,
          status: 'ACTIVE',
          intentionTag: 'SELL',
        }),
      },
      matchingJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const matching = { runMatchForListing: jest.fn().mockResolvedValue([]) };
    const alerts = { runMatchForListing: jest.fn().mockResolvedValue([]) };
    const service = new MatchingJobsService(prisma as any, matching as any, alerts as any);

    await expect(service.processPending(10)).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(matching.runMatchForListing).toHaveBeenCalledWith('listing-1', 'listing_updated', 3);
    expect(alerts.runMatchForListing).toHaveBeenCalledWith('listing-1', 'listing_updated', 3);
    expect(prisma.matchingJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'COMPLETED' }),
    }));
  });

  it('skips superseded listing versions without running either matcher', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: 'job-1', entityType: 'Listing', entityId: 'listing-1', entityVersion: 2, reason: 'listing_updated', attempts: 1,
      }]),
      listing: { findUnique: jest.fn().mockResolvedValue({ version: 3, status: 'ACTIVE', intentionTag: 'SELL' }) },
      matchingJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const matching = { runMatchForListing: jest.fn() };
    const alerts = { runMatchForListing: jest.fn() };
    const service = new MatchingJobsService(prisma as any, matching as any, alerts as any);

    await service.processPending();
    expect(matching.runMatchForListing).not.toHaveBeenCalled();
    expect(alerts.runMatchForListing).not.toHaveBeenCalled();
  });
});
