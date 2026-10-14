import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { instance, mock, when } from 'ts-mockito';
import { describe, expect, test, vi } from 'vitest';
import { GetLastPtsDurationTask } from './GetLastPtsDuration.ts';

vi.mock(import('node:child_process'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

async function probe(packets: string | string[]) {
  const stdout = new PassThrough();
  const proc = Object.assign(new ChildProcess(), { stdout });
  vi.mocked(spawn).mockReturnValueOnce(proc);
  const settings = mock<ISettingsDB>();
  when(settings.ffprobePath).thenReturn('/test/ffprobe');
  const result = new GetLastPtsDurationTask(instance(settings)).run(
    '/test/last.ts',
  );
  for (const chunk of typeof packets === 'string' ? [packets] : packets) {
    stdout.write(chunk);
  }
  stdout.end();
  await new Promise<void>((resolve) => stdout.on('end', resolve));
  proc.emit('close', 0);
  return result;
}

describe('GetLastPtsDurationTask', () => {
  test('does not treat a split packet line as a missing duration', async () => {
    const result = await probe([
      '723750|3750|\n725580|',
      '1920|\n720000|3750|\n',
    ]);
    expect(result.getOrThrow()).toEqual({ pts: 723750, duration: 3750 });
  });

  test('uses the latest presentation end, not the last B-frame in decode order', async () => {
    const result = await probe('723750|3750|\n720000|3750|\n');
    expect(result.getOrThrow()).toEqual({ pts: 723750, duration: 3750 });
  });

  test('compares packet end times rather than PTS alone for interleaved audio', async () => {
    const result = await probe('724000|1000|\n723500|1920|\n720000|3750|\n');
    expect(result.getOrThrow()).toEqual({ pts: 723500, duration: 1920 });
  });

  test('ignores blank and non-packet lines when valid packets exist', async () => {
    const result = await probe('N/A|N/A|\n\n725580|1920|\nside_data\n');
    expect(result.getOrThrow()).toEqual({ pts: 725580, duration: 1920 });
  });

  test('preserves the existing fallback for a missing packet duration', async () => {
    const result = await probe('90000|N/A|\n');
    expect(result.getOrThrow()).toEqual({ pts: 90000, duration: 10000 });
  });

  test.each(['', 'N/A|N/A|\n'])(
    'fails if there is no numeric PTS: %j',
    async (packets) => {
      const result = await probe(packets);
      expect(result.isFailure()).toBe(true);
    },
  );
});
