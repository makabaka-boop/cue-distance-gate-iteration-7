/**
 * Bounded insertion/deletion distance between two cue sequences.
 *
 * Cost model: insertion = 1, deletion = 1, substitution = 2 (a substitution
 * is exactly delete + insert, so the distance equals n + m - 2 * LCS(a, b)).
 * Elements compare by integer equality only.
 *
 * The true distance is reported exactly when it is <= k; anything larger
 * yields { status: 'exceeded' } and nothing more.
 *
 * Implementation: banded dynamic programming over the diagonal stripe
 * |i - j| <= k. Every insert/delete moves the frontier off the diagonal by
 * one, so any cell with |i - j| > k has distance > k and can never belong
 * to an optimal path within budget. This gives O((n + m) * k) time and
 * O(m) memory (two rolling rows) — no O(n * m) table is ever built, which
 * keeps 50_000-item sequences with k <= 500 cheap.
 */

export interface DistanceOk {
  status: 'ok';
  distance: number;
}

export interface DistanceExceeded {
  status: 'exceeded';
}

export type DistanceResult = DistanceOk | DistanceExceeded;

export function boundedCueDistance(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  k: number,
): DistanceResult {
  if (!Number.isInteger(k) || k < 0) {
    throw new RangeError('k must be a non-negative integer');
  }

  const n = a.length;
  const m = b.length;

  // Each insert/delete changes the length gap by exactly one, so a gap
  // larger than k can never be closed within budget.
  if (Math.abs(n - m) > k) {
    return { status: 'exceeded' };
  }

  // Sentinel meaning "greater than k"; exact values above k are irrelevant.
  const INF = k + 1;

  let prev = new Int32Array(m + 1).fill(INF);
  let curr = new Int32Array(m + 1).fill(INF);

  // Row 0: turning the empty prefix of a into b[0..j) costs j insertions.
  const hi0 = Math.min(m, k);
  for (let j = 0; j <= hi0; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    const lo = Math.max(0, i - k);
    const hi = Math.min(m, i + k);

    // Sentinels just outside the band: neighbours whose true value
    // exceeds k. They must be reset because the buffers are recycled.
    if (lo === 0) curr[0] = i; // deleting i items costs i (<= k here)
    else curr[lo - 1] = INF;
    if (hi < m) curr[hi + 1] = INF;

    const ai = a[i - 1];
    for (let j = Math.max(1, lo); j <= hi; j++) {
      let best = prev[j - 1] + (ai === b[j - 1] ? 0 : 2); // match / substitute
      const del = prev[j] + 1; // delete a[i-1]
      if (del < best) best = del;
      const ins = curr[j - 1] + 1; // insert b[j-1]
      if (ins < best) best = ins;
      curr[j] = best > INF ? INF : best;
    }

    const swap = prev;
    prev = curr;
    curr = swap;
  }

  const d = prev[m];
  return d <= k ? { status: 'ok', distance: d } : { status: 'exceeded' };
}
