import { describe, expect, test, vi } from 'vitest';
import type { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import type { IWorkerPool } from '../interfaces/IWorkerPool.ts';
import type { TVGuideService } from '../services/TvGuideService.ts';
import { RegenerateChannelLineupCommand } from './RegenerateChannelLineupCommand.ts';
import type { Lineup } from '../db/derived_types/Lineup.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';
import { prepareCreditLineup } from '../util/creditSkip.ts';
import { calculateStartTimeOffsets } from '../db/lineupUtil.ts';
import { calculateStreamDuration } from '../stream/StreamProgramCalculator.ts';

vi.mock('../services/TvGuideService.ts', () => ({ TVGuideService: class {} }));

function setup(scheduleSeed?: number[]) {
  const channelDB = {
    loadChannelAndLineupOrm: vi.fn().mockResolvedValue({
      channel: { uuid: 'ch1', startTime: 1000 },
      lineup: {
        items: [],
        schedule: { type: 'time', slots: [] },
        scheduleSeed,
      },
    }),
    replaceChannelPrograms: vi.fn(),
    saveLineup: vi.fn(async (_id: string, update: Partial<Lineup>) => ({
      items: [],
      ...update,
    })),
    updateChannelDuration: vi.fn(async (_id: string, _duration: number) => {}),
  };
  const queueTask = vi.fn().mockResolvedValue({
    result: {
      lineup: [{ type: 'content', id: 'p1', duration: 500 }],
      seed: [9, 9],
    },
  });
  const tvGuideService = {
    updateCachedChannel: vi.fn().mockResolvedValue(undefined),
  };

  const command = new RegenerateChannelLineupCommand(
    channelDB as unknown as IChannelDB,
    () => ({ queueTask }) as unknown as IWorkerPool,
    tvGuideService as unknown as TVGuideService,
  );
  return { command, channelDB, queueTask };
}

describe('RegenerateChannelLineupCommand', () => {
  test('uses the saved retained cycle instead of overwriting it with raw scheduler durations', async () => {
    const { command, channelDB, queueTask } = setup([1, 2, 3]);
    const drizzle = {
      query: {
        program: {
          findMany: vi.fn().mockResolvedValue([
            {
              uuid: 'p1',
              type: 'movie',
              duration: 100_000,
              versions: [
                {
                  duration: 100_000,
                  chapters: [
                    {
                      chapterType: 'outro',
                      startTime: 80_000,
                      endTime: 94_000,
                    },
                  ],
                },
              ],
            },
          ]),
        },
      },
    } as unknown as DrizzleDBAccess;
    queueTask.mockResolvedValue({
      result: {
        lineup: [
          { type: 'content', id: 'p1', duration: 100_000 },
          { type: 'content', id: 'p2', duration: 60_000 },
        ],
        seed: [9, 9],
      },
    });
    let saved: Lineup | undefined;
    channelDB.saveLineup.mockImplementation(async (_id, update) => {
      const items = await prepareCreditLineup(
        drizzle,
        update.items ?? [],
        true,
      );
      saved = {
        version: 6,
        lastUpdated: 0,
        ...update,
        items,
        startTimeOffsets: calculateStartTimeOffsets(items),
      };
      return saved;
    });
    await command.execute({ channelId: 'ch1' });
    expect(saved?.scheduleSeed).toEqual([9, 9]);
    expect(saved?.startTimeOffsets).toEqual([0, 86_000, 146_000]);
    expect(channelDB.updateChannelDuration).toHaveBeenCalledWith(
      'ch1',
      146_000,
    );
    if (!saved) throw new Error('Lineup was not saved');
    const cycle = channelDB.updateChannelDuration.mock.calls[0]?.[1];
    if (cycle === undefined)
      throw new Error('Channel duration was not updated');
    const playback = calculateStreamDuration(
      3 * cycle + 96_000,
      0,
      cycle,
      saved,
    );
    expect(saved.items[playback.currentProgramIndex]).toMatchObject({
      id: 'p2',
    });
    expect(playback.timeElapsed).toBe(10_000);
  });

  test('replays the stored seed', async () => {
    const { command, queueTask } = setup([1, 2, 3]);

    await command.execute({ channelId: 'ch1' });

    expect(queueTask).toHaveBeenCalledWith({
      type: 'time-slots',
      request: expect.objectContaining({ seed: [1, 2, 3], startTime: 1000 }),
    });
  });

  test('stores the seed the scheduler used', async () => {
    const { command, channelDB } = setup();

    await command.execute({ channelId: 'ch1' });

    expect(channelDB.saveLineup).toHaveBeenCalledWith(
      'ch1',
      expect.objectContaining({ scheduleSeed: [9, 9] }),
    );
    expect(channelDB.replaceChannelPrograms).toHaveBeenCalledWith('ch1', [
      'p1',
    ]);
  });
});
