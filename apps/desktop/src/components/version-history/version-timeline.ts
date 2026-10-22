import type { NoteVersion } from "@/hooks/use-version-history";

/** Extra room between days, in versions. */
const DAY_GAP = 0.9;
/** Track inset at both ends, in percent. */
const EDGE = 2;

export interface TimelineMark {
  version: NoteVersion;
  /** Centre of the mark, as a percentage of the track width. */
  at: number;
  /** The day label, on the first version of each day. */
  day: string | null;
}

function dayStart(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

export function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Versions (newest first) laid out oldest to newest along the track: every
 * version gets equal room, and a little more opens up between days.
 */
export function timelineMarks(versions: NoteVersion[], now = Date.now()): TimelineMark[] {
  const oldestFirst = [...versions].reverse();
  const units: number[] = [];
  const newDay: boolean[] = [];
  let x = 0;
  oldestFirst.forEach((version, i) => {
    newDay.push(i === 0 || dayStart(version.updatedAt) !== dayStart(oldestFirst[i - 1].updatedAt));
    if (i > 0) x += newDay[i] ? 1 + DAY_GAP : 1;
    units.push(x);
  });
  const total = x + 1;
  return oldestFirst.map((version, i) => ({
    version,
    at: EDGE + ((units[i] + 0.5) / total) * (100 - 2 * EDGE),
    day: newDay[i] ? dayLabel(version.updatedAt, now) : null,
  }));
}

/** Below this many pixels between versions, ticks are too close to point at. */
const CROWDED_SPACING = 8;

/** Whether versions sit too close together on a track `width` pixels wide to pick out one. */
export function isCrowded(positions: number[], width: number): boolean {
  for (let i = 1; i < positions.length; i++) {
    if (((positions[i] - positions[i - 1]) / 100) * width < CROWDED_SPACING) return true;
  }
  return false;
}

/** How many versions either side of its focus the pointer lens spreads out. */
const LENS_REACH = 6;
/** Pixels between the versions under the lens. */
const LENS_SPACING = 10;
/** How far, in pixels, the pointer moves across the lens before the lens follows it. */
const LENS_HOLD = 48;

export interface LensShape {
  /** How many times wider the gaps at the focus grow, before the track is rescaled. */
  peak: number;
  /** The hold distance, in percent. */
  hold: number;
}

/** A lens that spreads the versions under it `LENS_SPACING` pixels apart on a track `width` pixels wide. */
export function lensShape(positions: number[], width: number): LensShape {
  const gaps = positions.length - 1;
  const span = gaps > 0 ? ((positions[gaps] - positions[0]) / 100) * width : 0;
  const reach = LENS_REACH * Math.sqrt(Math.PI);
  const room = span - LENS_SPACING * reach;
  // With no room left over, the lens takes nearly the whole track.
  const peak = room > 0 ? (LENS_SPACING * (gaps - reach)) / room : gaps;
  return { peak: Math.max(1, peak), hold: width > 0 ? (LENS_HOLD / width) * 100 : 0 };
}

/**
 * Positions under a lens centred on version `focus` (fractional): gaps near
 * it widen and every other gap gives up room in proportion, so the first and
 * last versions stay put and neither end gets squeezed.
 */
export function magnify(positions: number[], focus: number, peak: number, strength = 1): number[] {
  const lift = (peak - 1) * strength;
  if (positions.length < 2 || lift <= 0) return positions;
  const lengths = [0];
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    const weight = 1 + lift * Math.exp(-(((i - 0.5 - focus) / LENS_REACH) ** 2));
    total += (positions[i] - positions[i - 1]) * weight;
    lengths.push(total);
  }
  if (total === 0) return positions;
  const first = positions[0];
  const span = positions[positions.length - 1] - first;
  return lengths.map((length) => first + (length / total) * span);
}

/** Where fractional version `index` sits among `positions`. */
function spotOf(positions: number[], index: number): number {
  const below = Math.max(0, Math.min(positions.length - 2, Math.floor(index)));
  const t = index - below;
  return positions[below] + t * ((positions[below + 1] ?? positions[below]) - positions[below]);
}

/** The lens focus that puts its own spot `offset` percent short of `pointer`. */
export function focusAt(positions: number[], pointer: number, peak: number, offset = 0): number {
  const target = pointer - offset;
  let low = 0;
  let high = Math.max(0, positions.length - 1);
  for (let step = 0; step < 32; step++) {
    const mid = (low + high) / 2;
    if (spotOf(magnify(positions, mid, peak), mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * The lens holds still while the pointer moves within `hold` percent of its
 * focus, so the spread-out versions can be reached; past that it slides along.
 */
export function holdFocus(
  positions: number[],
  focus: number,
  pointer: number,
  { peak, hold }: LensShape,
): number {
  const at = spotOf(magnify(positions, focus, peak), focus);
  if (pointer > at + hold) return focusAt(positions, pointer, peak, hold);
  if (pointer < at - hold) return focusAt(positions, pointer, peak, -hold);
  return focus;
}

/** Indexes of the day labels that fit `minGap` percent apart, keeping the newest day. */
export function visibleDays(marks: TimelineMark[], positions: number[], minGap: number): number[] {
  const shown: number[] = [];
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i].day === null) continue;
    const last = shown[shown.length - 1];
    if (last === undefined || positions[last] - positions[i] >= minGap) shown.push(i);
  }
  return shown.reverse();
}

/** Index of the position closest to `at` percent along the track. */
export function nearestMark(positions: number[], at: number): number {
  let best = 0;
  positions.forEach((position, i) => {
    if (Math.abs(position - at) < Math.abs(positions[best] - at)) best = i;
  });
  return best;
}
