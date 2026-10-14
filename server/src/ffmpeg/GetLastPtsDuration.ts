import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import { Result } from '@/types/result.js';
import { isNonEmptyString } from '@/util/index.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type PtsAndDuration = {
  pts: number;
  duration: number;
};

export class GetLastPtsDurationTask {
  constructor(private settingsDB: ISettingsDB) {}

  async run(segmentFilePath: string): Promise<Result<PtsAndDuration>> {
    const args = [
      '-v',
      '0',
      '-show_entries',
      'packet=pts,duration',
      '-of',
      'compact=p=0:nk=1',
      segmentFilePath,
    ];

    const proc = spawn(this.settingsDB.ffprobePath, args, {
      stdio: ['ignore', 'pipe', process.stderr],
    });

    let lastLine: string = '';
    let latestPacket: PtsAndDuration | undefined;
    // Buffer complete lines so a split duration cannot trigger the fallback.
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const str = line.trim();
      if (isNonEmptyString(str)) {
        lastLine = str;
        const parsed = Result.attempt(() => parsePtsAndDuration(str));
        parsed.forEach((packet) => {
          // Packets are interleaved in decode order. B-frames and audio
          // can end later than the final packet's presentation time.
          if (
            latestPacket === undefined ||
            packet.pts + packet.duration >
              latestPacket.pts + latestPacket.duration
          ) {
            latestPacket = packet;
          }
        });
      }
    });

    return new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', () => {
        resolve(
          Result.attempt(() => latestPacket ?? parsePtsAndDuration(lastLine)),
        );
      });
    });
  }
}

function parsePtsAndDuration(str: string): PtsAndDuration {
  const [pts, duration] = str.split('|', 2);
  const ptsParsed = parseFloat(pts!);
  if (isNaN(ptsParsed)) {
    throw new Error(`PTS was not a number: got ${str}`);
  }
  let durationParsed = parseFloat(duration!);
  if (isNaN(durationParsed)) {
    durationParsed = 10_000;
  }
  return {
    pts: ptsParsed,
    duration: durationParsed,
  };
}
