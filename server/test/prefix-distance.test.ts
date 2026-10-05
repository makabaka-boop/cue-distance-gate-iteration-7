import { describe, expect, it } from 'vitest';
import { PrefixDistanceTracker } from '../src/prefix-distance.js';

/**
 * Short-sequence full-DP oracle. For a plan b and live prefixes a[0..i) it
 * keeps the whole edit-distance table and answers exactly the questions the
 * incremental tracker is asked online:
 *
 *   boundary(i) = min over j of D(a[0..i), b[0..j))   — recoverability bound
 *   final(i)    = D(a[0..i), b)                        — whole-plan distance
 *
 * Costs: insert 1, delete 1, substitute 2. Exact for the tiny inputs the
 * tracker's banded (|i - j| <= k) state must agree with.
 */
function fullTable(a: number[], b: number[]): number[][] {
  const n = a.length;
  const m = b.length;
  const d: number[][] = [];
  for (let i = 0; i <= n; i++) {
    d.push(new Array<number>(m + 1).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 2),
      );
    }
  }
  return d;
}

function oracleBoundary(table: number[][], i: number, m: number, k: number): number {
  let min = Infinity;
  for (let j = 0; j <= m; j++) min = Math.min(min, table[i][j]);
  return Math.min(min, k + 1);
}

/** Deterministic PRNG for reproducible fuzzing. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('PrefixDistanceTracker — boundary after every cue vs full-DP oracle', () => {
  /** Drive the tracker cue by cue and check each prefix against the oracle. */
  function checkSequence(plan: number[], live: number[], k: number) {
    const tracker = new PrefixDistanceTracker(plan, k);
    const table = fullTable(live, plan);
    const m = plan.length;

    // i = 0: empty live prefix, boundary 0, recoverable, no final yet.
    let snap = tracker.snapshot();
    expect(snap).toMatchObject({
      k,
      plannedLength: m,
      liveLength: 0,
      boundary: 0,
      recoverable: true,
      final: null,
    });

    for (let i = 1; i <= live.length; i++) {
      tracker.append(live[i - 1]);
      snap = tracker.snapshot();
      const expectedBoundary = oracleBoundary(table, i, m, k);
      expect(snap.liveLength).toBe(i);
      expect(snap.boundary).toBe(expectedBoundary);
      expect(snap.recoverable).toBe(expectedBoundary <= k);
      expect(snap.final).toBeNull();
    }

    // Finalize: whole live sequence vs the whole plan.
    const exactFinal = table[live.length][m];
    const finalSnap = tracker.finalize();
    tracker.finalize(); // idempotent
    if (exactFinal <= k) {
      expect(finalSnap).toEqual({ status: 'ok', distance: exactFinal });
    } else {
      expect(finalSnap).toEqual({ status: 'exceeded' });
    }
    snap = tracker.snapshot();
    expect(snap.final).toEqual(
      exactFinal <= k ? { status: 'ok', distance: exactFinal } : { status: 'exceeded' },
    );
    return { exactFinal, snap };
  }

  it('exact match: boundary stays 0, final distance 0', () => {
    checkSequence([101, 102, 103], [101, 102, 103], 2);
  });

  it('one extra live cue: boundary dips as a longer planned prefix aligns, final cost 1', () => {
    // plan [101,102,103]; live inserts 205 between 102 and 103. After the
    // first three cues [101,102,205] the prefix [101,102] matches for cost 1
    // (205 pending), so the boundary is 1 <= k; once 103 arrives the whole
    // alignment only needs the single deletion of 205.
    const { exactFinal } = checkSequence([101, 102, 103], [101, 102, 205, 103], 1);
    expect(exactFinal).toBe(1);
  });

  it('missing a planned cue: boundary grows as live runs ahead, final deletion cost', () => {
    checkSequence([1, 2, 3, 4], [1, 2, 4], 1);
  });

  it('substitution (cost 2) within k = 2', () => {
    checkSequence([1, 2, 3], [1, 9, 3], 2);
  });

  it('empty plan: every live cue is a deletion, boundary == i capped', () => {
    const tracker = new PrefixDistanceTracker([], 2);
    tracker.append(7);
    expect(tracker.snapshot()).toMatchObject({ boundary: 1, recoverable: true });
    tracker.append(8);
    expect(tracker.snapshot()).toMatchObject({ boundary: 2, recoverable: true });
    tracker.append(9);
    const snap = tracker.snapshot();
    expect(snap.boundary).toBe(3);
    expect(snap.recoverable).toBe(false);
    expect(tracker.finalize()).toEqual({ status: 'exceeded' });
  });

  it('k = 0: first differing cue flips to unrecoverable and it sticks', () => {
    const tracker = new PrefixDistanceTracker([1, 2, 3], 0);
    tracker.append(1);
    expect(tracker.snapshot().recoverable).toBe(true);
    expect(tracker.snapshot().boundary).toBe(0);
    tracker.append(9);
    expect(tracker.snapshot().recoverable).toBe(false);
    expect(tracker.snapshot().boundary).toBe(1); // k + 1 sentinel
    // Coming back onto the plan cannot un-flip it.
    tracker.append(3);
    expect(tracker.snapshot().recoverable).toBe(false);
    expect(tracker.finalize()).toEqual({ status: 'exceeded' });
  });

  it('recoverable mid-show but exceeded at the end (unmatched planned tail)', () => {
    // Live stops early: at i=3 boundary 0 (plan prefix matched) but the
    // remaining 3 planned cues cost 3 deletions at finalize; k=1 exceeds.
    const { exactFinal } = checkSequence([1, 2, 3, 4, 5, 6], [1, 2, 3], 1);
    expect(exactFinal).toBe(3);
  });

  it('exceeded mid-show cannot be recovered even by a perfect remaining run', () => {
    // Live opens with two cues absent from the plan; boundary 2 > k=1, then
    // the rest matches the plan exactly — final is still exceeded.
    const tracker = new PrefixDistanceTracker([1, 2, 3, 4], 1);
    tracker.append(8);
    expect(tracker.snapshot().recoverable).toBe(true); // j=0 costs 1
    tracker.append(9);
    expect(tracker.snapshot().recoverable).toBe(false); // cost >= 2
    for (const cue of [1, 2, 3, 4]) tracker.append(cue);
    expect(tracker.snapshot().recoverable).toBe(false);
    const table = fullTable([8, 9, 1, 2, 3, 4], [1, 2, 3, 4]);
    expect(tracker.finalize().status).toBe(
      table[6][4] <= 1 ? 'ok' : 'exceeded',
    );
  });

  it('int32 extremes compare by integer equality', () => {
    checkSequence([-2147483648, 0, 2147483647], [-2147483648, 0, 2147483647], 0);
    checkSequence([-2147483648], [2147483647], 2);
  });

  it('repeated identical elements (LCS-style alignment)', () => {
    checkSequence([7, 7, 7], [7, 7], 1);
    checkSequence([1, 2, 1, 2], [2, 1, 2, 1], 2);
  });

  // ----------------------------------------------------- randomized fuzzing
  it('fuzz: every prefix boundary and the final verdict match the full-DP oracle', () => {
    const rand = mulberry32(20260924);
    for (let trial = 0; trial < 400; trial++) {
      const m = Math.floor(rand() * 9);
      const n = Math.floor(rand() * 9);
      // Tiny alphabet so matches/substitutions/indels all occur.
      const alphabet = [1, 2, 3, (trial % 2) + 1];
      const plan = Array.from({ length: m }, () => alphabet[Math.floor(rand() * alphabet.length)]!);
      const live = Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]!);
      const k = Math.floor(rand() * 5);
      checkSequence(plan, live, k);
    }
  });

  it('fuzz: k = 0 and k = 500 extremes with short sequences', () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 50; trial++) {
      const plan = Array.from({ length: 4 + Math.floor(rand() * 4) }, (_, i) => i);
      const live = plan
        .slice()
        .sort(() => rand() - 0.5)
        .slice(0, plan.length - Math.floor(rand() * 3));
      checkSequence(plan, live, 0);
      checkSequence(plan, live, 500);
    }
  });
});

describe('PrefixDistanceTracker — cost per cue and band discipline', () => {
  it('one append is O(k) work even with a 50k plan', () => {
    const plan = Array.from({ length: 50_000 }, (_, i) => i + 1);
    const tracker = new PrefixDistanceTracker(plan, 5);
    const t0 = performance.now();
    // Perfect run: the frontier walks the diagonal; 200 cues must stay fast.
    for (let i = 1; i <= 200; i++) tracker.append(i);
    const elapsed = performance.now() - t0;
    expect(tracker.snapshot()).toMatchObject({ boundary: 0, recoverable: true });
    // Generous ceiling: banded work must not scan the 50k row per cue.
    expect(elapsed).toBeLessThan(1000);
  });
});
