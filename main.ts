// gta6-twitch-ccu-forecast-01 entry: a comparables-based quantile forecast.
//
// Idea: a launch's Twitch audience follows a diurnal shape set by the
// midnight-local unlock rolling around the world -- quiet in the small
// hours, a step up when the US East Coast unlocks, another when the West
// Coast does, a peak in US prime time, then a slow fall. No single launch
// shows that shape cleanly, so this program learns it from the case's own
// `comparables`: the hourly curves of 42 past big launches. For each
// comparable it takes the log-ratio of each release-day hour to that
// launch's hour-1 print, then forecasts the case's hours as the weighted
// median of those log-ratios, scaled by the case's own hour-1 print.
//
// Three refinements, all tuned on the kit's four practice cases:
//   - weights: console-only midnight-rolling launches count most; early
//     access and mixed PC+console launches count less; launches whose peak
//     is near the case's hour-1 print count more (similar scale);
//   - ramp: a launch whose pre-release day already peaked far above its
//     hour-1 print ramps harder, so the whole curve shifts up by a fraction
//     of the log gap between the case's pre-release peak ratio and the
//     comparables' median one;
//   - spread: the quantiles come from the weighted interquartile range of
//     the log-ratios, so the band is as wide as past launches disagree.
//
// It runs offline, standard library only, deterministic, and fast: the
// comparables are a few tens of thousands of points at most. Output is
// /output/<id>.out, {"hours":[{"hour":h,"q":[q05,q25,q50,q75,q95]}]} for
// hours 2..24. A case that cannot be read still gets a valid output (the
// persistence fallback), because an invalid case takes no prize.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

/** How much of the interquartile spread to keep (tuned on practice). */
const SPREAD_K = 0.65;
/** The narrowest log-spread any hour gets. */
const SPREAD_FLOOR = 0.25;
/** How much of the pre-release ramp gap shifts the curve (tuned on practice). */
const RAMP_BETA = 0.4;
/** Log-distance scale for the similar-size weight. */
const SCALE_SIGMA = 1.5;

interface HourlyPoint {
  from: string;
  viewers: number | null;
  channels?: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly: HourlyPoint[];
}

interface CaseFile {
  id: string;
  day_start: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history?: Array<{ at: string; viewers: number | null }>;
  history_hourly?: HourlyPoint[];
  comparables: Comparable[];
}

/** Milliseconds since the epoch for an ISO 8601 UTC timestamp. */
const ms = (s: string): number => Date.parse(s);

/** x rounded to 2 decimals (half up), clamped into the contest's bounds. */
const clean = (x: number): number => {
  const r = Math.round(x * 100) / 100;
  if (!Number.isFinite(r)) return 1;
  if (r < 0.01) return 0.01;
  if (r > 1e9) return 1e9;
  return r;
};

/** Weighted median of (weight, value) pairs. */
const wMedian = (pairs: Array<[number, number]>): number => {
  const sorted = pairs.slice().sort((a, b) => a[1] - b[1]);
  const total = sorted.reduce((s, p) => s + p[0], 0);
  let acc = 0;
  for (const [w, v] of sorted) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return sorted[sorted.length - 1][1];
};

/** Weighted q-quantile of (weight, value) pairs. */
const wQuantile = (pairs: Array<[number, number]>, q: number): number => {
  const sorted = pairs.slice().sort((a, b) => a[1] - b[1]);
  const total = sorted.reduce((s, p) => s + p[0], 0);
  let acc = 0;
  for (const [w, v] of sorted) {
    acc += w;
    if (acc >= total * q) return v;
  }
  return sorted[sorted.length - 1][1];
};

/** Plain median of numbers. */
const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * A comparable's release-day hourly curve, {hour 1..24: viewers}, with
 * log-linear interpolation across the odd missing hour. Null when hour 1
 * is missing or fewer than 12 of the 24 hours can be read.
 */
const dayCurve = (comp: Comparable): Map<number, number> | null => {
  const start = ms(comp.day_start);
  const pts: Array<[number, number]> = [];
  for (const p of comp.hourly) {
    if (p.viewers === null || p.viewers === undefined) continue;
    pts.push([(ms(p.from) - start) / 3600000, p.viewers]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  if (pts.length === 0) return null;
  const at = (off: number): number | null => {
    let lo = -1;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i][0] <= off) lo = i;
      else break;
    }
    if (lo >= 0 && pts[lo][0] === off) return Math.max(1, pts[lo][1]);
    if (lo < 0 || lo + 1 >= pts.length) return null;
    const [x0, y0] = pts[lo];
    const [x1, y1] = pts[lo + 1];
    if (y0 <= 0 || y1 <= 0) return null;
    const f = (off - x0) / (x1 - x0);
    return Math.exp(Math.log(y0) * (1 - f) + Math.log(y1) * f);
  };
  const curve = new Map<number, number>();
  for (let h = 1; h <= 24; h++) {
    const v = at(h - 1);
    if (v !== null) curve.set(h, v);
  }
  const v1 = curve.get(1);
  if (v1 === undefined || v1 <= 0 || curve.size < 12) return null;
  return curve;
};

/** How much a comparable should count, by how like this launch it is. */
const compWeight = (comp: Comparable, peak: number, p1: number): number => {
  let w = 1;
  const plats = (comp.platforms ?? '').toLowerCase();
  const unlock = (comp.unlock ?? '').toLowerCase();
  if (unlock.includes('early access') || unlock.includes('early-access')) w *= 0.3;
  if (plats.includes('pc') && (plats.includes('ps5') || plats.includes('ps4') || plats.includes('xbox'))) w *= 0.7;
  if (unlock.includes('midnight')) w *= 1.3;
  if (plats.includes('switch')) w *= 0.8;
  // Launches of a similar size count more: a 10k-viewer indie ramps
  // nothing like a 500k-viewer blockbuster.
  const d = (Math.log(peak) - Math.log(p1)) / SCALE_SIGMA;
  w *= Math.exp(-0.5 * d * d);
  return w;
};

/** A launch's pre-release peak ratio: its busiest hour in the day before
 *  release day, over its hour-1 print. */
const prePeakRatio = (comp: Comparable, curve: Map<number, number>): number | null => {
  const start = ms(comp.day_start);
  let peak = 0;
  for (const p of comp.hourly) {
    const dt = (ms(p.from) - start) / 3600000;
    if (dt >= -24 && dt < 0 && p.viewers !== null && p.viewers !== undefined) {
      peak = Math.max(peak, p.viewers);
    }
  }
  const v1 = curve.get(1);
  if (!peak || !v1) return null;
  return peak / v1;
};

/** The case's own pre-release peak ratio, from its hourly history. */
const casePreRatio = (c: CaseFile, p1: number): number | null => {
  const start = ms(c.day_start);
  let peak = 0;
  const rows = c.history_hourly ?? [];
  for (const p of rows) {
    const dt = (ms(p.from) - start) / 3600000;
    if (dt >= -24 && dt < 0 && p.viewers !== null && p.viewers !== undefined) {
      peak = Math.max(peak, p.viewers);
    }
  }
  if (!peak) {
    // Fall back to the minute reads.
    for (const p of c.history ?? []) {
      const dt = (ms(p.at) - start) / 3600000;
      if (dt >= -24 && dt < 0 && p.viewers !== null && p.viewers !== undefined) {
        peak = Math.max(peak, p.viewers);
      }
    }
  }
  if (!peak) return null;
  return peak / p1;
};

/** The persistence fallback: every hour at hour 1's print, widening spread. */
const fallbackHours = (p1: number): Array<{ hour: number; q: number[] }> => {
  const hours: Array<{ hour: number; q: number[] }> = [];
  for (let h = 2; h <= 24; h++) {
    const q = Z.map((z) => clean(p1 * Math.exp(z * 0.15 * Math.sqrt(h - 1))));
    hours.push({ hour: h, q });
  }
  return hours;
};

/** The forecast for one case. Never throws: on any surprise it falls back
 *  to the persistence forecast, which is always a valid output. */
const forecastCase = (c: CaseFile): Array<{ hour: number; q: number[] }> => {
  const first = c.known.find((k) => k.hour === 1);
  const p1 = Math.max(1, first ? first.viewers : 1);
  try {
    // Build the pool: each comparable's log-ratios to its own hour 1.
    const pool: Array<{ w: number; lr: Map<number, number>; pre: number | null }> = [];
    for (const comp of c.comparables ?? []) {
      const curve = dayCurve(comp);
      if (!curve) continue;
      const v1 = curve.get(1) as number;
      const lr = new Map<number, number>();
      for (let h = 2; h <= 24; h++) {
        const v = curve.get(h);
        if (v !== undefined && v > 0) lr.set(h, Math.log(v / v1));
      }
      if (lr.size < 12) continue;
      let peak = 0;
      for (const v of curve.values()) peak = Math.max(peak, v);
      pool.push({ w: compWeight(comp, peak, p1), lr, pre: prePeakRatio(comp, curve) });
    }
    if (pool.length < 3) return fallbackHours(p1);
    // The ramp shift: how much busier the case's pre-release day was,
    // against the comparables' median, in log units. Clamped, so a freak
    // pre-release spike (a trailer premiere, a leak) cannot drag the
    // whole day's curve up or down by more than a factor of ~2.
    let shift = 0;
    const targetPre = casePreRatio(c, p1);
    if (targetPre !== null) {
      const pres = pool.map((e) => e.pre).filter((x): x is number => x !== null);
      if (pres.length > 0) {
        const raw = RAMP_BETA * (Math.log(targetPre) - Math.log(median(pres)));
        shift = Math.max(-0.75, Math.min(0.75, raw));
      }
    }
    const hours: Array<{ hour: number; q: number[] }> = [];
    for (let h = 2; h <= 24; h++) {
      const vals: Array<[number, number]> = [];
      for (const e of pool) {
        const v = e.lr.get(h);
        if (v !== undefined) vals.push([e.w, v]);
      }
      if (vals.length < 3) {
        hours.push({ hour: h, q: fallbackHours(p1)[h - 2].q });
        continue;
      }
      const med = wMedian(vals) + shift;
      const q25 = wQuantile(vals, 0.25);
      const q75 = wQuantile(vals, 0.75);
      let s = Math.max(SPREAD_FLOOR, 0.5 * (q75 - q25) * 1.349 * SPREAD_K);
      s = Math.max(s, 0.15 * Math.sqrt(h - 1) * 0.7);
      const q = Z.map((z) => clean(p1 * Math.exp(med + z * s)));
      hours.push({ hour: h, q });
    }
    return hours;
  } catch {
    return fallbackHours(p1);
  }
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
