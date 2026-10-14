import type { Kysely } from 'kysely';
import type { RegenerateChannelLineupCommand } from '@/commands/RegenerateChannelLineupCommand.ts';
import { sumBy } from 'lodash-es';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  Lineup,
  LineupItem,
  OnDemandChannelConfig,
} from '@/db/derived_types/Lineup.ts';
import type { IChannelDB } from '@/db/interfaces/IChannelDB.ts';
import { calculateStartTimeOffsets } from '@/db/lineupUtil.ts';
import type { DB } from '@/db/schema/db.ts';
import { GlobalScheduler } from '@/services/Scheduler.ts';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.ts';
import { calculateStreamDuration } from '@/stream/StreamProgramCalculator.ts';
import { ReconcileProgramDurationsTask } from './ReconcileProgramDurationsTask.ts';
import type { DrizzleDBAccess } from '@/db/schema/index.ts';
import { prepareCreditLineup, resolveCreditSkip } from '@/util/creditSkip.ts';

function creditProgram(
  duration = 100_000,
  startTime = 80_000,
  endTime = 94_000,
) {
  return {
    uuid: 'a',
    type: 'movie',
    duration,
    versions: [
      { duration, chapters: [{ chapterType: 'outro', startTime, endTime }] },
    ],
  };
}

function skippedItem() {
  const program = creditProgram();
  return {
    type: 'content' as const,
    id: 'a',
    startOffsetMs: 0,
    durationMs: 86_000,
    creditSkip: resolveCreditSkip(
      program.type,
      program.duration,
      program.versions,
    ),
  };
}

const NOW = 1_760_000_000_000;

type Fixture = {
  items: LineupItem[];
  programs: { uuid: string; duration: number }[];
  creditPrograms?: ReturnType<typeof creditProgram>[];
  autoSkipCredits?: boolean;
  startTime?: number;
  onDemandConfig?: OnDemandChannelConfig;
  schedule?: Lineup['schedule'];
  scheduleSeed?: number[];
};

const timeSchedule = {
  type: 'time',
  slots: [],
} as unknown as NonNullable<Lineup['schedule']>;

function setup({
  items,
  programs,
  startTime = 0,
  onDemandConfig,
  schedule,
  scheduleSeed,
  creditPrograms = [],
  autoSkipCredits = false,
}: Fixture) {
  let lineup: Lineup = {
    version: 6,
    lastUpdated: 0,
    items,
    startTimeOffsets: calculateStartTimeOffsets(items),
    onDemandConfig,
    schedule,
    scheduleSeed,
  };
  const channel = {
    uuid: 'ch1',
    startTime,
    duration: sumBy(items, (i) => i.durationMs),
    autoSkipCredits,
  };

  const drizzle = {
    query: { program: { findMany: vi.fn().mockResolvedValue(creditPrograms) } },
  } as unknown as DrizzleDBAccess;

  const channelDB = {
    getAllChannels: vi.fn().mockResolvedValue([channel]),
    loadLineup: vi.fn(async () => lineup),
    loadChannelAndLineup: vi.fn(async () => ({ channel, lineup })),
    saveLineup: vi.fn(async (_id: string, update: Partial<Lineup>) => {
      const savedItems = await prepareCreditLineup(
        drizzle,
        update.items ?? lineup.items,
        autoSkipCredits,
      );
      lineup = {
        ...lineup,
        ...update,
        items: savedItems,
        startTimeOffsets: calculateStartTimeOffsets(savedItems),
      };
      channel.duration = sumBy(savedItems, (item) => item.durationMs);
      return lineup;
    }),
    updateChannelStartTime: vi.fn().mockResolvedValue(undefined),
    updateLineupConfig: vi.fn(
      async (_id: string, _key: string, _config: OnDemandChannelConfig) => {},
    ),
  };

  const db = {
    selectFrom: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(programs),
        }),
      }),
    }),
  } as unknown as Kysely<DB>;

  const onDemandService = {
    runWithChannelLock: vi.fn((_id: string, cb: () => Promise<unknown>) =>
      cb(),
    ),
  } as unknown as OnDemandChannelService;

  const regenerateLineup = {
    execute: vi.fn().mockResolvedValue(undefined),
  };

  const task = new ReconcileProgramDurationsTask(
    channelDB as unknown as IChannelDB,
    db,
    onDemandService,
    regenerateLineup as unknown as RegenerateChannelLineupCommand,
    drizzle,
  );

  return {
    task,
    channel,
    lineup,
    channelDB,
    onDemandService,
    regenerateLineup,
  };
}

describe('ReconcileProgramDurationsTask', () => {
  let scheduleOneOff: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    scheduleOneOff = vi
      .spyOn(GlobalScheduler, 'scheduleOneOffTask')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('an unchanged credit plan does not consume flex or move playback on repeated scans', async () => {
    const items: LineupItem[] = [
      skippedItem(),
      { type: 'offline', durationMs: 30_000 },
      { type: 'content', id: 'b', durationMs: 60_000 },
    ];
    const { task, channelDB } = setup({
      items,
      programs: [creditProgram(), { uuid: 'b', duration: 60_000 }],
      creditPrograms: [creditProgram()],
      autoSkipCredits: true,
      onDemandConfig: { state: 'paused', cursor: 126_000 },
    });
    await task.run(undefined);
    await task.run(undefined);
    const saved = await channelDB.loadLineup();
    expect(saved.items).toEqual(items);
    expect(saved.startTimeOffsets).toEqual([0, 86_000, 116_000, 176_000]);
    expect(channelDB.saveLineup).not.toHaveBeenCalled();
    expect(channelDB.updateLineupConfig).not.toHaveBeenCalled();
  });

  test.each([
    ['grown source', creditProgram(120_000), 106_000, 10_000],
    [
      'changed source with equal retained duration',
      creditProgram(110_000, 80_000, 104_000),
      86_000,
      30_000,
    ],
    [
      'moved markers with equal retained duration',
      creditProgram(100_000, 70_000, 84_000),
      86_000,
      30_000,
    ],
    ['shortened source', creditProgram(60_000, 50_000, 60_000), 50_000, 66_000],
    [
      'changed markers',
      creditProgram(100_000, 80_000, 100_000),
      80_000,
      36_000,
    ],
    [
      'stale version markers',
      { ...creditProgram(), duration: 120_000 },
      120_000,
      0,
    ],
    ['removed markers', { ...creditProgram(), versions: [] }, 100_000, 16_000],
  ])(
    'reconciles %s in the retained timeline and remains stable',
    async (_name, program, retained, flex) => {
      const { task, channel, channelDB } = setup({
        items: [
          skippedItem(),
          { type: 'offline', durationMs: 30_000 },
          { type: 'content', id: 'b', durationMs: 60_000 },
        ],
        programs: [program, { uuid: 'b', duration: 60_000 }],
        creditPrograms: [program],
        autoSkipCredits: true,
        onDemandConfig: { state: 'paused', cursor: 126_000 },
      });
      await task.run(undefined);
      const saved = await channelDB.loadLineup();
      expect(saved.items.map((item) => item.durationMs)).toEqual(
        flex > 0 ? [retained, flex, 60_000] : [retained, 60_000],
      );
      expect(channel.duration).toBe(retained + flex + 60_000);
      const cursor = channelDB.updateLineupConfig.mock.calls[0]?.[2]?.cursor;
      expect(cursor).toBe(retained + flex + 10_000);
      if (cursor === undefined) throw new Error('Missing reconciled cursor');
      const playback = calculateStreamDuration(
        cursor,
        0,
        channel.duration,
        saved,
      );
      expect(saved.items[playback.currentProgramIndex]).toMatchObject({
        id: 'b',
      });
      expect(playback.timeElapsed).toBe(10_000);
      await task.run(undefined);
      expect(channelDB.saveLineup).toHaveBeenCalledTimes(1);
    },
  );

  test('a seeded auto-skip schedule regenerates only when its effective plan changes', async () => {
    const fixture = {
      items: [skippedItem()],
      programs: [creditProgram()],
      creditPrograms: [creditProgram()],
      autoSkipCredits: true,
      schedule: timeSchedule,
      scheduleSeed: [1, 2, 3],
    };
    const unchanged = setup(fixture);
    await unchanged.task.run(undefined);
    expect(unchanged.regenerateLineup.execute).not.toHaveBeenCalled();
    const changed = setup({
      ...fixture,
      creditPrograms: [creditProgram(100_000, 80_000, 100_000)],
    });
    await changed.task.run(undefined);
    expect(changed.regenerateLineup.execute).toHaveBeenCalledWith({
      channelId: 'ch1',
    });
  });

  test('corrects durations and recomputes startTimeOffsets', async () => {
    const { task, channelDB } = setup({
      items: [
        { type: 'content', id: 'p1', durationMs: 1000 },
        { type: 'content', id: 'p2', durationMs: 500 },
      ],
      programs: [
        { uuid: 'p1', duration: 60000 },
        { uuid: 'p2', duration: 30000 },
      ],
    });

    await task.run(undefined);

    expect(channelDB.saveLineup).toHaveBeenCalledTimes(1);
    expect(channelDB.saveLineup).toHaveBeenCalledWith(
      'ch1',
      expect.objectContaining({
        items: [
          { type: 'content', id: 'p1', durationMs: 60000 },
          { type: 'content', id: 'p2', durationMs: 30000 },
        ],
        startTimeOffsets: [0, 60000, 90000],
      }),
    );
    expect(scheduleOneOff).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { channelId: 'ch1' },
    );
  });

  test('rebases the start time to the minute so the current program keeps playing', async () => {
    const items: LineupItem[] = [
      { type: 'content', id: 'a', durationMs: 1_800_000 },
      { type: 'content', id: 'b', durationMs: 1_800_000 },
      { type: 'content', id: 'c', durationMs: 1_800_000 },
    ];
    const cycle = 5_400_000;
    // 120 cycles in, 10 minutes into b.
    const startTime = NOW - 120 * cycle - 2_400_000;
    const { task, channel, lineup, channelDB } = setup({
      items,
      startTime,
      programs: [
        { uuid: 'a', duration: 1_741_500 },
        { uuid: 'b', duration: 1_800_000 },
        { uuid: 'c', duration: 1_795_000 },
      ],
    });

    const before = calculateStreamDuration(NOW, startTime, cycle, lineup);
    await task.run(undefined);

    const savedItems = (
      channelDB.saveLineup.mock.calls[0]?.[1] as { items: LineupItem[] }
    ).items;
    const newStart = channelDB.updateChannelStartTime.mock.calls[0]?.[1] as
      | number
      | undefined;
    expect(newStart).toBeDefined();
    if (newStart === undefined) {
      return;
    }
    expect(newStart).toBeLessThanOrEqual(NOW);
    expect(newStart).toBeGreaterThan(channel.startTime - cycle);

    const newCycle = sumBy(savedItems, (i) => i.durationMs);
    const after = calculateStreamDuration(NOW, newStart, newCycle, {
      ...lineup,
      items: savedItems,
      startTimeOffsets: calculateStartTimeOffsets(savedItems),
    });

    expect(newStart % 60_000).toBe(0);
    expect(after.currentProgramIndex).toBe(before.currentProgramIndex);
    expect(
      Math.abs(after.timeElapsed - before.timeElapsed),
    ).toBeLessThanOrEqual(30_000);
  });

  test('moves an on-demand cursor instead of the start time', async () => {
    const { task, channelDB } = setup({
      items: [
        { type: 'content', id: 'a', durationMs: 1000 },
        { type: 'content', id: 'b', durationMs: 1000 },
      ],
      programs: [
        { uuid: 'a', duration: 700 },
        { uuid: 'b', duration: 1000 },
      ],
      onDemandConfig: {
        state: 'playing',
        cursor: 1000,
        lastResumed: NOW - 200,
      },
    });

    await task.run(undefined);

    expect(channelDB.updateChannelStartTime).not.toHaveBeenCalled();
    // 200 ms into b, which now starts at 700. The resume time is restamped
    // after the save so the next pause keeps the cursor.
    expect(channelDB.updateLineupConfig).toHaveBeenCalledWith(
      'ch1',
      'onDemandConfig',
      { state: 'playing', cursor: 900, lastResumed: NOW },
    );
  });

  test('keeps the resume time of a paused on-demand channel', async () => {
    const { task, channelDB } = setup({
      items: [
        { type: 'content', id: 'a', durationMs: 1000 },
        { type: 'content', id: 'b', durationMs: 1000 },
      ],
      programs: [{ uuid: 'a', duration: 700 }],
      onDemandConfig: {
        state: 'paused',
        cursor: 1500,
        lastResumed: NOW - 50_000,
        lastPaused: NOW - 40_000,
      },
    });

    await task.run(undefined);

    expect(channelDB.updateLineupConfig).toHaveBeenCalledWith(
      'ch1',
      'onDemandConfig',
      {
        state: 'paused',
        cursor: 1200,
        lastResumed: NOW - 50_000,
        lastPaused: NOW - 40_000,
      },
    );
  });

  test('writes nothing when durations already match', async () => {
    const { task, channelDB } = setup({
      items: [{ type: 'content', id: 'a', durationMs: 1000 }],
      programs: [{ uuid: 'a', duration: 1000 }],
    });

    await task.run(undefined);

    expect(channelDB.saveLineup).not.toHaveBeenCalled();
    expect(channelDB.updateChannelStartTime).not.toHaveBeenCalled();
    expect(scheduleOneOff).not.toHaveBeenCalled();
  });

  test('does not touch the start time of a channel that has not started', async () => {
    const { task, channelDB } = setup({
      items: [{ type: 'content', id: 'a', durationMs: 1000 }],
      programs: [{ uuid: 'a', duration: 2000 }],
      startTime: NOW + 60_000,
    });

    await task.run(undefined);

    expect(channelDB.saveLineup).toHaveBeenCalledTimes(1);
    expect(channelDB.updateChannelStartTime).not.toHaveBeenCalled();
  });

  test('regenerates a seeded slot schedule instead of patching it', async () => {
    const { task, channelDB, regenerateLineup } = setup({
      items: [{ type: 'content', id: 'a', durationMs: 1000 }],
      programs: [{ uuid: 'a', duration: 2000 }],
      startTime: NOW - 500,
      schedule: timeSchedule,
      scheduleSeed: [1, 2, 3],
    });

    await task.run(undefined);

    expect(regenerateLineup.execute).toHaveBeenCalledWith({ channelId: 'ch1' });
    expect(channelDB.saveLineup).not.toHaveBeenCalled();
    expect(channelDB.updateChannelStartTime).not.toHaveBeenCalled();
    expect(scheduleOneOff).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { channelId: 'ch1' },
    );
  });

  test('patches a slot lineup that has no seed, since it may be hand-edited', async () => {
    const { task, channelDB, regenerateLineup } = setup({
      items: [{ type: 'content', id: 'a', durationMs: 1000 }],
      programs: [{ uuid: 'a', duration: 2000 }],
      schedule: timeSchedule,
    });

    await task.run(undefined);

    expect(regenerateLineup.execute).not.toHaveBeenCalled();
    expect(channelDB.saveLineup).toHaveBeenCalledTimes(1);
  });

  test('leaves a seeded slot schedule alone when durations match', async () => {
    const { task, regenerateLineup } = setup({
      items: [{ type: 'content', id: 'a', durationMs: 1000 }],
      programs: [{ uuid: 'a', duration: 1000 }],
      schedule: timeSchedule,
      scheduleSeed: [1, 2, 3],
    });

    await task.run(undefined);

    expect(regenerateLineup.execute).not.toHaveBeenCalled();
  });
});
