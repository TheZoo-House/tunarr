import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FfmpegProcess } from '@/ffmpeg/FfmpegProcess.js';
import { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import { HlsSubtitleOutputFormat } from '@/ffmpeg/builder/options/HlsSubtitleOutputFormat.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import type { ProgramStream } from '@/stream/ProgramStream.js';
import type { StreamProgramCalculator } from '@/stream/StreamProgramCalculator.js';
import { Result } from '@/types/result.js';
import type retry from 'async-retry';
import dayjs from 'dayjs';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { HlsSessionOptions } from './HlsSession.js';
import { HlsSession } from './HlsSession.js';
import type { Cue } from './HlsSubtitlePlaylist.js';
import { parseCues, segmentWindows } from './HlsSubtitlePlaylist.js';

vi.mock('@/util/logging/LoggerFactory.js', () => ({
  LoggerFactory: {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('@/stream/ConnectionTracker.ts', () => ({
  ConnectionTracker: class {
    on = vi.fn();
    cancelCleanup = vi.fn();
  },
}));

// Keep the real readiness predicate and retry exhaustion, but not its 15s delay.
vi.mock('async-retry', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof retry }>();
  return {
    default: (
      fn: Parameters<typeof retry>[0],
      options: Parameters<typeof retry>[1],
    ) => actual.default(fn, { ...options, minTimeout: 1, maxTimeout: 1 }),
  };
});

class ReadinessHlsSession extends HlsSession {
  begin() {
    return this.startInternal();
  }

  ready() {
    return this.waitForStreamReady();
  }
}

const channel = {
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  number: 1,
  transcodeConfig: {},
} as ChannelOrmWithTranscodeConfig;

function makeSession(
  transcodeDirectory: string,
  streamMode: HlsSessionOptions['streamMode'] = 'hls',
  subtitles = true,
) {
  const started = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const processEvents = new EventEmitter();
  const output = new PassThrough();
  const process = Object.assign(processEvents, {
    start: () => {
      started.resolve();
      return output;
    },
    kill: () => {
      output.end();
      processEvents.emit('exit', 0, null, true);
      exited.resolve();
    },
    exited: exited.promise,
  });
  const transcode = new FfmpegTranscodeSession(
    process as unknown as FfmpegProcess,
    dayjs.duration(100, 'seconds'),
    dayjs().add(100, 'seconds'),
  );
  // This seam drives HlsSession.transcode(), including its real private
  // #currentSubtitleRendition. A BaseHlsSession-only fake would miss the bug.
  const programStream = Object.assign(new EventEmitter(), {
    setup: () => Promise.resolve(Result.success(transcode)),
    start: () => Promise.resolve(transcode.start()),
    transcodeSession: transcode,
    renditions: {
      audio: [],
      subtitle: subtitles
        ? { language: 'eng', default: true, forced: true }
        : undefined,
    },
  });
  const calculator = {
    getCurrentLineupItem: vi.fn().mockResolvedValue(
      Result.success({
        lineupItem: {
          type: 'offline',
          duration: 100_000,
          streamDuration: 100_000,
          programBeginMs: +dayjs(),
        },
        channelContext: channel,
        sourceChannel: channel,
      }),
    ),
  } as unknown as StreamProgramCalculator;
  const session = new ReadinessHlsSession(
    channel,
    { streamMode, transcodeDirectory, initialSegmentCount: 2 },
    calculator,
    {} as ISettingsDB,
    {
      getLiveTimestamp: (_id: string, timestamp: number) =>
        Promise.resolve(timestamp),
    } as OnDemandChannelService,
    () => programStream as unknown as ProgramStream,
  );
  return { session, started: started.promise };
}

async function writeVideo(session: HlsSession, segments = 2) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (let i = 0; i < segments; i++) {
    const filename = `data${String(i).padStart(6, '0')}.ts`;
    lines.push(
      '#EXTINF:4.000000,',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000+0000',
      filename,
    );
    await fs.writeFile(path.join(session.workingDirectory, filename), '');
  }
  await fs.writeFile(session.streamPath, lines.join('\n'));
  await fs.writeFile(
    session.masterPlaylistPath,
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nstream.m3u8\n',
  );
}

async function expectVirtualSubtitles(session: HlsSession) {
  const master = (await session.getMasterPlaylist()).get();
  expect(master).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES');
  expect(master).toContain('FORCED=YES');
  expect(master).toContain('SUBTITLES="subs"');
  expect(master).toContain(`/hls/subs.m3u8"`);
  const playlist = await session.alignedSubtitlePlaylist();
  expect(playlist).toContain('subs000000.vtt');
  expect(playlist).not.toMatch(/data\d+\.ts/);
  expect(await session.subtitleWindow(0)).toBe('WEBVTT\n');
  expect(await session.subtitleWindow(999999)).toBeUndefined();
}

describe('HlsSession subtitle readiness', () => {
  let directory: string;
  const sessions: ReadinessHlsSession[] = [];

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hls-readiness-'));
  });

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.stop()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function begin(
    mode: HlsSessionOptions['streamMode'] = 'hls',
    subtitles = true,
  ) {
    const fixture = makeSession(directory, mode, subtitles);
    sessions.push(fixture.session);
    await fixture.session.begin();
    await fixture.started;
    return fixture.session;
  }

  test.each([
    'sparse forced track',
    'no cues remaining after seek',
    'late first cue',
  ])(
    'normal HLS is ready without a physical subtitle playlist: %s',
    async (scenario) => {
      const session = await begin();
      await writeVideo(session, 17);
      if (scenario === 'late first cue') {
        await fs.writeFile(
          path.join(session.workingDirectory, 'sub000000.vtt'),
          'WEBVTT\n\n00:01:26.666 --> 00:01:29.500\nLate forced cue\n',
        );
      }
      expect(await fs.readdir(session.workingDirectory)).not.toContain(
        'subs.m3u8',
      );
      expect((await session.ready()).isSuccess()).toBe(true);
      await expectVirtualSubtitles(session);
    },
  );

  test('virtual windows stay blank until a late cue arrives, then retain it', async () => {
    const session = await begin();
    await writeVideo(session, 24);
    expect((await session.ready()).isSuccess()).toBe(true);
    expect(await session.subtitleWindow(21)).toBe('WEBVTT\n');
    await fs.writeFile(
      path.join(session.workingDirectory, 'sub000000.vtt'),
      'WEBVTT\n\n00:01:26.666 --> 00:01:29.500\nLate forced cue\n',
    );
    expect(await session.subtitleWindow(0)).toBe('WEBVTT\n');
    expect(parseCues((await session.subtitleWindow(21)) ?? '')).toEqual([
      {
        start: 86.666,
        block: '00:01:26.666 --> 00:01:29.500\nLate forced cue',
      },
    ]);
  });

  test.each(['video playlist', 'second video segment', 'all video segments'])(
    'does not become ready with selected subtitles but missing %s',
    async (missing) => {
      const session = await begin();
      await writeVideo(session);
      await fs.writeFile(
        path.join(session.workingDirectory, 'subs.m3u8'),
        '#EXTM3U\n',
      );
      const filenames =
        missing === 'video playlist'
          ? ['stream.m3u8']
          : missing === 'second video segment'
            ? ['data000001.ts']
            : ['data000000.ts', 'data000001.ts'];
      await Promise.all(
        filenames.map((filename) =>
          fs.unlink(path.join(session.workingDirectory, filename)),
        ),
      );
      expect((await session.ready()).isFailure()).toBe(true);
    },
  );

  test('direct-v2 still requires its physical subtitle playlist when selected', async () => {
    const session = await begin('hls_direct_v2');
    await writeVideo(session);
    expect((await session.ready()).isFailure()).toBe(true);
  });

  test('direct-v2 becomes ready with its physical subtitle playlist', async () => {
    const session = await begin('hls_direct_v2');
    await writeVideo(session);
    await fs.writeFile(
      path.join(session.workingDirectory, 'subs.m3u8'),
      '#EXTM3U\n',
    );
    expect((await session.ready()).isSuccess()).toBe(true);
  });

  test.each(['hls', 'hls_direct_v2'] as const)(
    '%s without selected subtitles does not require a subtitle playlist',
    async (mode) => {
      const session = await begin(mode, false);
      await writeVideo(session);
      expect((await session.ready()).isSuccess()).toBe(true);
      expect((await session.getMasterPlaylist()).get()).not.toContain(
        'TYPE=SUBTITLES',
      );
    },
  );

  // Opt in to local FFmpeg, with generated media only. No server or media source.
  test
    .runIf(process.env['TUNARR_HLS_READINESS_FFMPEG'] === '1')
    .each([723, 1363])(
    'real FFmpeg video and sparse SRT after seek %is',
    async (seek) => {
      const run = promisify(execFile);
      const ffmpeg = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
      const source = path.join(directory, 'source.mkv');
      const seekedSource = path.join(directory, 'seeked.mkv');
      const srt = path.join(directory, 'forced.srt');
      await fs.writeFile(
        srt,
        '1\n00:13:29,666 --> 00:13:30,500\nFirst forced cue\n\n2\n00:13:31,000 --> 00:13:32,500\nSecond forced cue\n',
      );
      await run(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=96x64:rate=2',
          '-t',
          '1464',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-g',
          '8',
          source,
        ],
        { timeout: 30_000 },
      );
      // Normalize video after its seek, then pace startup separately from the
      // subtitle input so the readiness snapshot precedes the first cue.
      await run(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-ss',
          String(seek),
          '-i',
          source,
          '-t',
          '100',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-g',
          '8',
          seekedSource,
        ],
        { timeout: 30_000 },
      );
      const session = await begin();
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-i',
        seekedSource,
        // FFmpeg 9's SRT demuxer fails a seek past its final cue and can
        // replay it at zero. Use an output seek for the no-remaining-cues
        // fixture instead; this changes only how that fixture is produced.
        ...(seek === 723 ? ['-ss', String(seek)] : []),
        '-i',
        srt,
        '-map',
        '0:v:0',
        '-t',
        '100',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '8',
        '-sc_threshold',
        '0',
        '-b:v',
        '100k',
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_list_size',
        '0',
        '-hls_flags',
        'program_date_time',
        '-master_pl_name',
        'playlist.m3u8',
        '-hls_segment_filename',
        path.join(session.workingDirectory, 'data%06d.ts'),
        session.streamPath,
        ...(seek === 1363 ? ['-ss', String(seek)] : []),
        ...new HlsSubtitleOutputFormat(
          path.join(session.workingDirectory, 'subs.m3u8'),
          path.join(session.workingDirectory, 'sub%06d.vtt'),
          '',
          '1:s:0',
        ).options(),
      ];
      const transcode = run(
        ffmpeg,
        ['-re', '-readrate_initial_burst', '20', ...args],
        {
          timeout: 30_000,
        },
      );
      // Attach rejection handling before polling, including when an assertion fails.
      const finished = transcode.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await vi.waitFor(
          async () => {
            const files = await fs.readdir(session.workingDirectory);
            expect(
              files.filter((file) => /^data\d+\.ts$/.test(file)).length,
            ).toBeGreaterThanOrEqual(2);
            expect(files).toContain('stream.m3u8');
          },
          { timeout: 10_000, interval: 20 },
        );
        expect(await fs.readdir(session.workingDirectory)).not.toContain(
          'subs.m3u8',
        );
        expect((await session.ready()).isSuccess()).toBe(true);
        await expectVirtualSubtitles(session);
        const blankVtt = path.join(directory, 'blank.vtt');
        await fs.writeFile(blankVtt, (await session.subtitleWindow(0)) ?? '');
        const probe = await run(
          process.env['FFPROBE_PATH'] ?? 'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_name',
            '-of',
            'json',
            blankVtt,
          ],
          { timeout: 30_000 },
        );
        expect(JSON.parse(probe.stdout)).toMatchObject({
          streams: [{ codec_name: 'webvtt' }],
        });
        // Decode a completed startup segment before interrupting the live fixture.
        await run(
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-xerror',
            '-i',
            path.join(session.workingDirectory, 'data000000.ts'),
            '-map',
            '0:v:0',
            '-f',
            'null',
            '-',
          ],
          { timeout: 30_000 },
        );
        transcode.child.kill('SIGTERM');
        await finished;
        // Finish the same seek without pacing so later cues can be checked without
        // waiting 86 seconds. Keep the live-start assertions on the first process.
        await run(ffmpeg, ['-y', ...args], {
          timeout: 30_000,
        });
        await run(
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-xerror',
            '-i',
            session.streamPath,
            '-map',
            '0:v:0',
            '-f',
            'null',
            '-',
          ],
          { timeout: 30_000 },
        );
        const playlist = (await session.getPlaylist())?.join('\n') ?? '';
        const cues: Cue[] = [];
        for (const segment of segmentWindows(playlist).keys()) {
          const vtt = await session.subtitleWindow(segment);
          expect(vtt).toMatch(/^WEBVTT\n/);
          cues.push(...parseCues(vtt ?? ''));
        }
        if (seek === 723) {
          expect(cues.map((cue) => cue.start)).toEqual([86.666, 88]);
          expect(cues.map((cue) => cue.block).join('\n')).toContain(
            'Second forced cue',
          );
        } else {
          expect(cues).toEqual([]);
        }
      } finally {
        transcode.child.kill('SIGKILL');
        await finished;
      }
    },
    60_000,
  );
});
