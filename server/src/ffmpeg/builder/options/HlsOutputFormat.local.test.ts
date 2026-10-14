import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { ISettingsDB } from '../../../db/interfaces/ISettingsDB.ts';
import { instance, mock, when } from 'ts-mockito';
import { GetLastPtsDurationTask } from '../../GetLastPtsDuration.ts';
import { discoverFfmpegBinaries } from '../../../testing/ffmpeg/FfmpegIntegrationHelper.ts';
import { FrameState } from '../state/FrameState.ts';
import { FrameSize } from '../types.ts';
import { HlsOutputFormat } from './HlsOutputFormat.ts';
import { HlsDirectOutputFormat } from './HlsDirectOutputFormat.ts';
import {
  NoDemuxDecodeDelayOutputOption,
  OutputTsOffsetOption,
} from './OutputOption.ts';

const binaries = discoverFfmpegBinaries();
const PacketSchema = z.object({
  packets: z.array(
    z.object({
      codec_type: z.string(),
      pts: z.number(),
      dts: z.number(),
      duration: z.number(),
    }),
  ),
});

// Each process restarts its TS continuity counters. Check the actual bytes,
// not just the playlist's EXT-X-DISCONTINUITY or the command's option names.
function firstPackets(file: string) {
  const bytes = readFileSync(file);
  const packets = new Map<number, { cc: number; discontinuity: boolean }>();
  expect(bytes.length % 188).toBe(0);
  for (let offset = 0; offset < bytes.length; offset += 188) {
    expect(bytes[offset]).toBe(0x47);
    const pid =
      ((bytes.readUInt8(offset + 1) & 0x1f) << 8) | bytes.readUInt8(offset + 2);
    if (!packets.has(pid)) {
      const adaptation = (bytes.readUInt8(offset + 3) >> 4) & 3;
      packets.set(pid, {
        cc: bytes.readUInt8(offset + 3) & 0x0f,
        discontinuity:
          (adaptation & 2) !== 0 &&
          bytes.readUInt8(offset + 4) > 0 &&
          (bytes.readUInt8(offset + 5) & 0x80) !== 0,
      });
    }
  }
  return packets;
}

function segments(playlist: string) {
  return readFileSync(playlist, 'utf8')
    .split('\n')
    .filter((line) => line.endsWith('.ts'));
}

describe.skipIf(!binaries)('HLS generated A/V item boundaries', () => {
  test.each([
    ['transcode', '24', '30'],
    ['transcode', '30', '24000/1001'],
    ['copy', '24', '30'],
  ])(
    '%s: %s to %s fps with appended processes',
    async (mode, firstRate, secondRate) => {
      if (!binaries) throw new Error('FFmpeg and FFprobe are required');
      const { ffmpeg, ffprobe } = binaries;
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tunarr-hls-boundary-'));
      const commands: object[] = [];
      const evidence: Record<string, unknown> = {
        mode,
        firstRate,
        secondRate,
        commands,
      };
      function run(binary: string, args: string[]) {
        const result = spawnSync(binary, args, {
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        commands.push({
          binary,
          args,
          status: result.status,
          error: result.error?.message,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        return result;
      }
      function successful(binary: string, args: string[]) {
        const result = run(binary, args);
        expect(result.error, `${binary} ${args.join(' ')}`).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return result;
      }
      function probe(file: string) {
        return PacketSchema.parse(
          JSON.parse(
            successful(ffprobe, [
              '-v',
              'error',
              '-show_packets',
              '-show_entries',
              'packet=codec_type,pts,dts,duration',
              '-of',
              'json',
              file,
            ]).stdout,
          ),
        ).packets;
      }
      const playlist = path.join(dir, 'stream.m3u8');
      function transcode(
        source: string,
        rate: string,
        first: boolean,
        ptsOffset: number,
      ) {
        const [numerator, denominator = '1'] = rate.split('/');
        const numericRate = Number(numerator) / Number(denominator);
        const state = new FrameState({
          isAnamorphic: false,
          scaledSize: FrameSize.withDimensions(160, 90),
          paddedSize: FrameSize.withDimensions(160, 90),
        });
        successful(ffmpeg, [
          '-hide_banner',
          '-loglevel',
          'warning',
          '-y',
          ...(mode === 'copy' ? [] : ['-ss', first ? '1.25' : '0.75']),
          '-i',
          source,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          ...(mode === 'copy'
            ? ['-c', 'copy']
            : [
                '-t',
                '8',
                '-c:v',
                'libx264',
                '-preset',
                'fast',
                '-bf',
                '2',
                '-pix_fmt',
                'yuv420p',
                '-sc_threshold',
                '0',
                '-c:a',
                'aac',
                '-ar',
                '48000',
              ]),
          ...NoDemuxDecodeDelayOutputOption().options(),
          ...(mode === 'copy'
            ? []
            : OutputTsOffsetOption(ptsOffset, 90_000).options()),
          ...(mode === 'copy'
            ? new HlsDirectOutputFormat(
                playlist,
                path.join(dir, 'data%06d.ts'),
                '',
                first,
              ).options()
            : new HlsOutputFormat(
                state,
                numericRate,
                playlist,
                path.join(dir, 'data%06d.ts'),
                '',
                first,
                false,
              ).options()),
        ]);
      }
      function decode(file: string, fineTimebase: boolean) {
        return run(ffmpeg, [
          '-hide_banner',
          '-loglevel',
          'warning',
          '-xerror',
          '-err_detect',
          'explode',
          '-live_start_index',
          '0',
          '-i',
          file,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-fps_mode',
          'passthrough',
          ...(fineTimebase ? ['-enc_time_base:v', '1:90000'] : []),
          '-progress',
          'pipe:1',
          '-f',
          'null',
          '-',
        ]);
      }
      try {
        for (const [index, rate] of [firstRate, secondRate].entries()) {
          successful(ffmpeg, [
            '-hide_banner',
            '-loglevel',
            'warning',
            '-y',
            '-f',
            'lavfi',
            '-i',
            `testsrc2=size=160x90:rate=${rate}`,
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=${440 + index * 220}:sample_rate=48000`,
            '-t',
            '10',
            '-c:v',
            'libx264',
            '-preset',
            'fast',
            '-bf',
            '2',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            // Direct mode preserves the source clock. Give item 2 its own
            // later clock, rather than manufacturing a timestamp regression.
            ...(mode === 'copy' && index === 1
              ? ['-output_ts_offset', '12']
              : []),
            path.join(dir, `source${index}.mp4`),
          ]);
        }
        transcode(path.join(dir, 'source0.mp4'), firstRate, true, 0);
        const before = segments(playlist);
        const lastName = before.at(-1);
        if (lastName === undefined)
          throw new Error('No first-transcode segments');
        const lastSegment = path.join(dir, lastName);
        // Exercise the real probe used by HlsSession.getPtsOffset.
        const settings = mock<ISettingsDB>();
        when(settings.ffprobePath).thenReturn(ffprobe);
        const { pts, duration } = (
          await new GetLastPtsDurationTask(instance(settings)).run(lastSegment)
        ).getOrThrow();
        const ptsOffset = pts + duration + 1;
        expect(Number.isFinite(ptsOffset)).toBe(true);
        evidence.ptsOffset = ptsOffset;
        transcode(path.join(dir, 'source1.mp4'), secondRate, false, ptsOffset);
        const after = segments(playlist);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.length).toBeGreaterThan(before.length);
        const text = readFileSync(playlist, 'utf8');
        evidence.playlist = text;
        expect(text).toMatch(
          new RegExp(
            `#EXT-X-DISCONTINUITY\\n(?:#[^\\n]*\\n)*${after[before.length]}`,
          ),
        );
        // Finalize only the captured playlist, as if its live source ended.
        writeFileSync(playlist, `${text}#EXT-X-ENDLIST\n`);
        const nextName = after[before.length];
        if (nextName === undefined)
          throw new Error('No second-transcode segments');
        const newPackets = firstPackets(path.join(dir, nextName));
        evidence.firstPackets = Object.fromEntries(newPackets);
        const continuous = decode(playlist, true);
        expect(continuous.status, continuous.stderr).toBe(0);
        expect(continuous.stderr).not.toMatch(
          /corrupt|non.monoton|invalid|error/i,
        );
        expect(continuous.stdout).toContain('progress=end');
        const frames = [...continuous.stdout.matchAll(/^frame=(\d+)/gm)].at(-1);
        expect(Number(frames?.[1])).toBe(mode === 'copy' ? 540 : 432);
        // A coarse null encoder timebase may round distinct 30 fps PTS to
        // the same 24 fps tick. Compare it against the demuxed packet times.
        const coarse = decode(playlist, false);
        evidence.coarseDecode = {
          status: coarse.status,
          stderr: coarse.stderr,
        };
        expect(coarse.status, coarse.stderr).toBe(0);
        expect(coarse.stderr).not.toMatch(
          /Packet corrupt|corrupt input|increasing dts to muxer in stream 1/,
        );
        if (firstRate === '24' && secondRate === '30') {
          expect(coarse.stderr).toMatch(/increasing dts to muxer in stream 0/);
        }
        const allPackets = probe(playlist);
        for (const kind of ['video', 'audio']) {
          const packets = allPackets.filter(
            (packet) => packet.codec_type === kind,
          );
          const prior = probe(lastSegment).filter(
            (packet) => packet.codec_type === kind,
          );
          const next = probe(path.join(dir, nextName)).filter(
            (packet) => packet.codec_type === kind,
          );
          evidence[`${kind}Boundary`] = {
            priorLast: prior.at(-1),
            priorMaxEnd: Math.max(
              ...prior.map((packet) => packet.pts + packet.duration),
            ),
            nextFirst: next[0],
          };
          expect(packets.length).toBeGreaterThan(300);
          for (let index = 1; index < packets.length; index++) {
            const current = packets[index];
            const previous = packets[index - 1];
            if (current === undefined || previous === undefined)
              throw new Error('Missing packet');
            expect(current.dts, `${kind} DTS packet ${index}`).toBeGreaterThan(
              previous.dts,
            );
          }
        }
        for (const name of after) {
          const segment = path.join(dir, name);
          const result = successful(ffmpeg, [
            '-hide_banner',
            '-loglevel',
            'warning',
            '-xerror',
            '-err_detect',
            'explode',
            '-i',
            segment,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0',
            '-fps_mode',
            'passthrough',
            '-enc_time_base:v',
            '1:90000',
            '-f',
            'null',
            '-',
          ]);
          expect(result.stderr).not.toMatch(
            /corrupt|non.monoton|invalid|error/i,
          );
        }
        // Default MPEG-TS video and audio PIDs, plus PAT and PMT, must signal
        // the counter restart to the persistent HLS MPEG-TS demuxer.
        for (const pid of [0, 4096, 256, 257]) {
          expect(newPackets.get(pid), `PID ${pid}`).toMatchObject({
            discontinuity: true,
          });
        }
        evidence.passed = true;
      } finally {
        const evidenceDir = process.env['TUNARR_HLS_TEST_EVIDENCE_DIR'];
        if (evidenceDir !== undefined) {
          mkdirSync(evidenceDir, { recursive: true });
          writeFileSync(
            path.join(
              evidenceDir,
              `${mode}-${firstRate}-${secondRate.replace('/', '_')}.json`,
            ),
            JSON.stringify(evidence, null, 2),
          );
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
