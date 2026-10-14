import type { CondensedChannelProgram } from '@tunarr/types';
import type { CreditSkip } from '@tunarr/types/schemas';
import type { LineupItem } from '../db/derived_types/Lineup.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';

type Chapter = { chapterType: string; startTime: number; endTime: number };
type Version = { duration: number; chapters?: Chapter[] };

export function resolveCreditSkip(
  type: string,
  duration: number,
  versions: Version[],
): CreditSkip | undefined {
  if (
    (type !== 'movie' && type !== 'episode') ||
    versions.length !== 1 ||
    !Number.isSafeInteger(duration) ||
    duration <= 0
  )
    return;
  const version = versions[0];
  if (!version || version.duration !== duration) return;
  const markers = (version.chapters ?? []).filter(
    (c) => c.chapterType === 'outro',
  );
  if (
    markers.length === 0 ||
    markers.some(
      (c) =>
        !Number.isSafeInteger(c.startTime) ||
        !Number.isSafeInteger(c.endTime) ||
        c.startTime < 0 ||
        c.endTime <= c.startTime ||
        c.endTime > duration,
    )
  )
    return;

  const segments: CreditSkip['segments'] = [];
  let cursor = 0;
  for (const marker of [...markers].sort((a, b) => a.startTime - b.startTime)) {
    if (marker.startTime > cursor) {
      segments.push({
        startOffsetMs: cursor,
        durationMs: marker.startTime - cursor,
      });
    }
    cursor = Math.max(cursor, marker.endTime);
  }
  if (cursor < duration)
    segments.push({ startOffsetMs: cursor, durationMs: duration - cursor });
  // A marker covering the entire file cannot establish that any content remains.
  if (segments.length === 0) return;
  return { sourceStartOffsetMs: 0, sourceDurationMs: duration, segments };
}

export function creditSkipDuration(plan: CreditSkip): number {
  return plan.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
}

export function creditSkipPlayback(plan: CreditSkip, elapsed: number) {
  let cursor = 0;
  for (const segment of plan.segments) {
    if (elapsed < cursor + segment.durationMs) {
      const offset = elapsed - cursor;
      return {
        startOffsetMs: segment.startOffsetMs + offset,
        durationMs: segment.durationMs - offset,
        segmentStartMs: cursor,
      };
    }
    cursor += segment.durationMs;
  }
  throw new Error(
    'Credit-skip playback offset is outside the retained content',
  );
}

// Slice in the retained timeline, keeping the original source span for reversal.
export function sliceCreditSkip(
  plan: CreditSkip,
  start: number,
  duration: number,
): CreditSkip | undefined {
  const end = start + duration;
  const total = creditSkipDuration(plan);
  if (start < 0 || duration <= 0 || end > total) return;
  let cursor = 0;
  const segments: CreditSkip['segments'] = [];
  for (const segment of plan.segments) {
    const from = Math.max(start, cursor);
    const to = Math.min(end, cursor + segment.durationMs);
    if (to > from)
      segments.push({
        startOffsetMs: segment.startOffsetMs + from - cursor,
        durationMs: to - from,
      });
    cursor += segment.durationMs;
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return;
  let sourceStartOffsetMs = plan.sourceStartOffsetMs;
  let sourceCursor = 0;
  if (start > 0) {
    for (const segment of plan.segments) {
      // Assign a skipped gap at a cut boundary to the following source span.
      if (start <= sourceCursor + segment.durationMs) {
        sourceStartOffsetMs = segment.startOffsetMs + start - sourceCursor;
        break;
      }
      sourceCursor += segment.durationMs;
    }
  }
  const sourceEnd =
    end === total
      ? plan.sourceStartOffsetMs + plan.sourceDurationMs
      : last.startOffsetMs + last.durationMs;
  return {
    sourceStartOffsetMs,
    sourceDurationMs: sourceEnd - sourceStartOffsetMs,
    segments,
  };
}

export async function loadCreditSkips(db: DrizzleDBAccess, ids: string[]) {
  const plans = new Map<string, CreditSkip>();
  const unique = [...new Set(ids)];
  for (let index = 0; index < unique.length; index += 500) {
    const programs = await db.query.program.findMany({
      where: (fields, { inArray }) =>
        inArray(fields.uuid, unique.slice(index, index + 500)),
      columns: { uuid: true, type: true, duration: true },
      with: { versions: { with: { chapters: true } } },
    });
    for (const program of programs) {
      const plan = resolveCreditSkip(
        program.type,
        program.duration,
        program.versions,
      );
      if (plan) plans.set(program.uuid, plan);
    }
  }
  return plans;
}

export async function prepareCreditLineup(
  db: DrizzleDBAccess,
  items: readonly LineupItem[],
  enabled: boolean,
): Promise<LineupItem[]> {
  const plans = enabled
    ? await loadCreditSkips(
        db,
        items.flatMap((item) =>
          item.type === 'content' && !item.fillerListId ? [item.id] : [],
        ),
      )
    : new Map<string, CreditSkip>();
  return items.flatMap((item) => prepareCreditItem(item, plans));
}

// Use the same source-span clipping for persistence and duration reconciliation.
export function prepareCreditItem(
  item: LineupItem,
  plans: ReadonlyMap<string, CreditSkip>,
): LineupItem[] {
  if (item.type !== 'content' || item.fillerListId) return [item];
  const { creditSkip, ...rest } = item;
  const sourceStart =
    creditSkip?.sourceStartOffsetMs ?? item.startOffsetMs ?? 0;
  const sourceDuration = creditSkip?.sourceDurationMs ?? item.durationMs;
  const original = {
    ...rest,
    durationMs: sourceDuration,
    startOffsetMs: sourceStart,
  };
  const plan = plans.get(item.id);
  if (
    !plan ||
    sourceStart < 0 ||
    sourceStart + sourceDuration > plan.sourceDurationMs
  )
    return [creditSkip ? original : item];
  const segments = plan.segments.flatMap((segment) => {
    const start = Math.max(sourceStart, segment.startOffsetMs);
    const end = Math.min(
      sourceStart + sourceDuration,
      segment.startOffsetMs + segment.durationMs,
    );
    return end > start
      ? [{ startOffsetMs: start, durationMs: end - start }]
      : [];
  });
  if (segments.length === 0) return [];
  const nextPlan = {
    sourceStartOffsetMs: sourceStart,
    sourceDurationMs: sourceDuration,
    segments,
  };
  const durationMs = creditSkipDuration(nextPlan);
  if (durationMs === sourceDuration) return [original];
  return [{ ...original, durationMs, creditSkip: nextPlan }];
}

export function scheduleCreditSkips(
  lineup: CondensedChannelProgram[],
  programs: { uuid: string; creditSkip?: CreditSkip }[],
): CondensedChannelProgram[] {
  const plans = new Map(
    programs.map((program) => [program.uuid, program.creditSkip]),
  );
  return lineup.map((item) => {
    if (item.type !== 'content' && item.type !== 'custom') return item;
    const plan = plans.get(item.id);
    if (!plan) return item;
    const creditSkip = sliceCreditSkip(
      plan,
      item.startOffsetMs ?? 0,
      item.duration,
    );
    if (!creditSkip) return item;
    return {
      ...item,
      startOffsetMs: creditSkip.sourceStartOffsetMs,
      creditSkip,
    };
  });
}
