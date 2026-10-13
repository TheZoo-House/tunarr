import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PlexMarkerSchema } from '@tunarr/types/plex';
import { ChannelSchema, SaveableChannelSchema } from '@tunarr/types/schemas';
import { schema } from '../db/schema/index.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';
import { calculateStartTimeOffsets } from '../db/lineupUtil.ts';
import { LineupSchema } from '../db/derived_types/Lineup.ts';
import type { LineupItem } from '../db/derived_types/Lineup.ts';
import {
  creditSkipDuration,
  creditSkipPlayback,
  prepareCreditLineup,
  resolveCreditSkip,
  scheduleCreditSkips,
  sliceCreditSkip,
} from './creditSkip.ts';

const duration = 100_000;
const outro = (startTime: number, endTime: number) => ({
  chapterType: 'outro',
  startTime,
  endTime,
});
const chapters = [outro(80_000, 90_000), outro(94_000, 98_000)];
const version = { duration, chapters };
const plan = resolveCreditSkip('movie', duration, [version]);
if (!plan) throw new Error('Invalid test credit plan');

describe('credit intervals', () => {
  test('retains mid-credit and post-credit scenes, even without final metadata', () => {
    expect(plan.segments).toEqual([
      { startOffsetMs: 0, durationMs: 80_000 },
      { startOffsetMs: 90_000, durationMs: 4_000 },
      { startOffsetMs: 98_000, durationMs: 2_000 },
    ]);
    expect(creditSkipDuration(plan)).toBe(86_000);
    expect(creditSkipPlayback(plan, 80_000)).toEqual({
      startOffsetMs: 90_000,
      durationMs: 4_000,
      segmentStartMs: 80_000,
    });
    expect(creditSkipPlayback(plan, 85_750)).toEqual({
      startOffsetMs: 99_750,
      durationMs: 250,
      segmentStartMs: 84_000,
    });
  });
  test('unions overlapping, duplicate and adjacent intervals in source order', () => {
    const resolved = resolveCreditSkip('episode', duration, [
      {
        duration,
        chapters: [
          outro(90_000, 95_000),
          outro(80_000, 90_000),
          outro(85_000, 92_000),
          outro(80_000, 90_000),
        ],
      },
    ]);
    expect(resolved?.segments).toEqual([
      { startOffsetMs: 0, durationMs: 80_000 },
      { startOffsetMs: 95_000, durationMs: 5_000 },
    ]);
  });
  test.each([
    outro(-1, 90_000),
    outro(80_000, 80_000),
    outro(90_000, 80_000),
    outro(80_000, 100_001),
    outro(NaN, 90_000),
    outro(80_000, Infinity),
    outro(80_000.5, 90_000),
    outro(0, duration),
  ])('preserves playback for unusable markers %j', (chapter) => {
    expect(
      resolveCreditSkip('movie', duration, [{ duration, chapters: [chapter] }]),
    ).toBeUndefined();
  });
  test('does not guess from chapter titles, absent markers or ambiguous versions', () => {
    expect(
      resolveCreditSkip('movie', duration, [
        {
          duration,
          chapters: [
            {
              ...outro(80_000, duration),
              chapterType: 'chapter',
              title: 'Credits',
            },
          ],
        },
      ]),
    ).toBeUndefined();
    expect(
      resolveCreditSkip('movie', duration, [{ duration, chapters: [] }]),
    ).toBeUndefined();
    expect(resolveCreditSkip('movie', duration, [])).toBeUndefined();
    expect(
      resolveCreditSkip('movie', duration, [version, version]),
    ).toBeUndefined();
    expect(
      resolveCreditSkip('movie', duration, [
        { ...version, duration: duration + 1 },
      ]),
    ).toBeUndefined();
    expect(resolveCreditSkip('track', duration, [version])).toBeUndefined();
  });
  test('maps mid-roll cuts on the retained timeline to source offsets', () => {
    const sliced = sliceCreditSkip(plan, 82_000, 4_000);
    expect(sliced?.segments).toEqual([
      { startOffsetMs: 92_000, durationMs: 2_000 },
      { startOffsetMs: 98_000, durationMs: 2_000 },
    ]);
    const lineup = scheduleCreditSkips(
      [
        {
          type: 'custom',
          id: 'movie',
          customShowId: 'show',
          index: 0,
          duration: 4_000,
          startOffsetMs: 82_000,
        },
        { type: 'filler', id: 'movie', fillerListId: 'list', duration },
      ],
      [{ uuid: 'movie', creditSkip: plan }],
    );
    expect(lineup[0]).toMatchObject({
      duration: 4_000,
      startOffsetMs: 92_000,
      creditSkip: sliced,
    });
    expect(lineup[1]).toEqual({
      type: 'filler',
      id: 'movie',
      fillerListId: 'list',
      duration,
    });
  });
  test.each([true, false, 0, 1])(
    'retains Plex final semantics for %p',
    (final) => {
      expect(
        PlexMarkerSchema.parse({
          startTimeOffset: 80_000,
          endTimeOffset: 90_000,
          type: 'credits',
          final,
        }).final,
      ).toBe(final === true || final === 1);
    },
  );
  test('old configuration defaults off, omitted writes preserve the persisted choice and invalid writes fail', () => {
    expect(ChannelSchema.shape.autoSkipCredits.parse(undefined)).toBe(false);
    expect(
      SaveableChannelSchema.shape.autoSkipCredits.parse(undefined),
    ).toBeUndefined();
    expect(
      SaveableChannelSchema.shape.autoSkipCredits.safeParse('true').success,
    ).toBe(false);
  });
  test('migration defaults existing channels off without inventing final metadata', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(
        "create table channel(uuid text); insert into channel values('old'); create table program_chapter(uuid text); insert into program_chapter values('old')",
      );
      sqlite.exec(
        readFileSync(
          new URL(
            '../migration/db/sql/0053_auto_skip_credits.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      expect(
        sqlite.prepare('select auto_skip_credits from channel').get(),
      ).toEqual({ auto_skip_credits: 0 });
      expect(
        sqlite.prepare('select is_final from program_chapter').get(),
      ).toEqual({ is_final: null });
    } finally {
      sqlite.close();
    }
  });
});

describe('lineup persistence policy', () => {
  let sqlite: Database.Database;
  let db: DrizzleDBAccess;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`create table program(uuid text, type text, duration integer);
      create table program_version(uuid text, created_at integer, updated_at integer, duration integer, sample_aspect_ratio text, display_aspect_ratio text, frame_rate text, scan_kind text, width integer, height integer, program_id text);
      create table program_chapter(uuid text, "index" integer, start_time integer, end_time integer, title text, chapter_type text, is_final integer, program_version_id text);
      insert into program values('movie', 'movie', 100000);
      insert into program_version values('version',0,0,100000,null,null,null,'progressive',1920,1080,'movie');
      insert into program_chapter values('first',0,80000,90000,null,'outro',0,'version'), ('last',1,94000,98000,null,'outro',1,'version');`);
    db = drizzle({ client: sqlite, schema, casing: 'snake_case' });
  });
  afterEach(() => sqlite.close());
  test('save/reload is idempotent, updates cycle offsets, and disable restores the source span', async () => {
    const original: LineupItem[] = [
      { type: 'content', id: 'movie', durationMs: duration },
      { type: 'offline', durationMs: 10_000 },
    ];
    const prepared = await prepareCreditLineup(db, original, true);
    expect(prepared[0]).toMatchObject({ durationMs: 86_000, creditSkip: plan });
    const persisted = LineupSchema.parse({
      version: 6,
      lastUpdated: 1,
      items: prepared,
      startTimeOffsets: calculateStartTimeOffsets(prepared),
    });
    expect(persisted.startTimeOffsets).toEqual([0, 86_000, 96_000]);
    expect(await prepareCreditLineup(db, persisted.items, true)).toEqual(
      prepared,
    );
    expect(await prepareCreditLineup(db, persisted.items, false)).toEqual([
      { ...original[0], startOffsetMs: 0 },
      original[1],
    ]);
    expect(original[0].durationMs).toBe(duration);
  });
  test('clips existing source segments without losing gaps or touching filler', async () => {
    const items: LineupItem[] = [
      {
        type: 'content',
        id: 'movie',
        startOffsetMs: 82_000,
        durationMs: 18_000,
      },
      {
        type: 'content',
        id: 'movie',
        durationMs: duration,
        fillerListId: 'list',
      },
    ];
    const prepared = await prepareCreditLineup(db, items, true);
    expect(prepared[0]).toMatchObject({
      durationMs: 6_000,
      creditSkip: { segments: plan.segments.slice(1) },
    });
    expect(prepared[1]).toEqual(items[1]);
    expect(await prepareCreditLineup(db, prepared, false)).toEqual(items);
  });
  test('omits a segment fully inside valid credit intervals', async () => {
    expect(
      await prepareCreditLineup(
        db,
        [
          {
            type: 'content',
            id: 'movie',
            startOffsetMs: 80_000,
            durationMs: 10_000,
          },
        ],
        true,
      ),
    ).toEqual([]);
  });
  test('scheduled segments keep every source interval for reversal at exact credit boundaries', async () => {
    const lineup = scheduleCreditSkips(
      [
        { type: 'content', id: 'movie', duration: 80_000 },
        {
          type: 'content',
          id: 'movie',
          startOffsetMs: 80_000,
          duration: 4_000,
        },
        {
          type: 'content',
          id: 'movie',
          startOffsetMs: 84_000,
          duration: 2_000,
        },
      ],
      [{ uuid: 'movie', creditSkip: plan }],
    );
    const items: LineupItem[] = lineup.flatMap((item) =>
      item.type === 'content'
        ? [
            {
              type: 'content',
              id: item.id,
              durationMs: item.duration,
              startOffsetMs: item.startOffsetMs,
              creditSkip: item.creditSkip,
            },
          ]
        : [],
    );
    const restored = await prepareCreditLineup(db, items, false);
    expect(restored.map((item) => item.durationMs)).toEqual([
      80_000, 14_000, 6_000,
    ]);
    expect(
      restored.map((item) =>
        item.type === 'content' ? item.startOffsetMs : undefined,
      ),
    ).toEqual([0, 80_000, 94_000]);
  });
  test('ignores client-supplied skip intervals and uses stored markers', async () => {
    const items: LineupItem[] = [
      {
        type: 'content',
        id: 'movie',
        durationMs: 1,
        creditSkip: {
          sourceStartOffsetMs: 0,
          sourceDurationMs: duration,
          segments: [{ startOffsetMs: 0, durationMs: 1 }],
        },
      },
    ];
    expect((await prepareCreditLineup(db, items, true))[0]).toMatchObject({
      durationMs: 86_000,
      creditSkip: plan,
    });
  });
});
