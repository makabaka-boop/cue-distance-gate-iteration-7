/**
 * Incremental bounded distance frontier for one planned performance.
 *
 * The stage manager registers live cues one at a time while the show is
 * running and wants to know, *before the show ends*, whether the deviation
 * has already grown unrecoverable. A planned cue sequence P (length m) and a
 * tolerance k are fixed when the session is created; the live sequence L
 * (length n) grows by one element per committed registerCue command.
 *
 * Costs are the same model as distance.ts: insertion 1, deletion 1,
 * substitution 2 (compare by integer equality). After the i-th live cue we
 * keep the DP row
 *
 *   D_i(j) = edit distance between L[0..i) (whole live prefix so far)
 *                               and   P[0..j) (each planned prefix)
 *
 * which is produced from the previous row with exactly the banded
 * |i - j| <= k recurrence used by boundedCueDistance — the cells outside
 * the band cannot belong to a path of total cost <= k, so a single ">"
 * (INF = k + 1) sentinel replaces every exact value above k. Two rolling
 * rows of width m + 1 keep memory O(m); one committed cue costs O(k) real
 * work (the band intersects a row in at most 2k + 1 cells).
 *
 * Recoverability: the *boundary* after i live cues is
 *
 *   boundary_i = min over j of D_i(j)
 *
 * i.e. the cheapest price at which the live prefix heard so far can end the
 * alignment at *some* planned prefix (deleting every not-yet-heard planned
 * cue afterwards costs nothing extra yet — those are precisely the costs
 * that future cues may still avoid). If boundary_i > k, every j already
 * costs more than the budget, and edit distance is monotone non-decreasing
 * when the live side is extended (D_{i+1}(j) >= min_{j'} D_i(j') holds cell
 * by cell), so no continuation can ever come back inside k: the deviation
 * is unrecoverable ("已超出容许范围"). boundary_i <= k means "仍可追回".
 *
 * The boundary never decreases and is sticky: once INF it stays INF.
 *
 * When the session ends, the full plan must be accounted for, so the final
 * verdict reads D_n(m) (whole live sequence vs the *whole* plan): an exact
 * distance when <= k, otherwise only the exceeded signal.
 */

export type FinalStatus = 'ok' | 'exceeded';

/** Whole-plan verdict (always produced by finalize()). */
export interface FinalVerdict {
  status: FinalStatus;
  /** Present only when status === 'ok'. */
  distance?: number;
}

export interface DeviationSnapshot {
  /** Tolerance fixed at creation; the plan itself never changes. */
  k: number;
  /** Number of cues in the fixed planned sequence. */
  plannedLength: number;
  /** Number of live cues committed so far. */
  liveLength: number;
  /**
   * min_j D_i(j), capped at k + 1. Exact while <= k so the console can show
   * how much of the budget is already spent; k + 1 means "greater than k".
   */
  boundary: number;
  /** boundary <= k — the deviation can still be reeled back in. */
  recoverable: boolean;
  /**
   * Present only once the session has ended and the whole plan was
   * compared: exact distance when status === 'ok', otherwise the distance
   * is withheld (only 'exceeded' is reported).
   */
  final: FinalVerdict | null;
}

export class PrefixDistanceTracker {
  private readonly plan: ArrayLike<number>;
  private readonly m: number;
  private readonly k: number;
  private readonly INF: number;

  private prev: Int32Array;
  private curr: Int32Array;
  /** Live cues appended so far (== number of rows computed). */
  private n = 0;
  private boundary = 0;
  private finalSnapshot: FinalVerdict | null = null;

  constructor(plan: ArrayLike<number>, k: number) {
    if (!Number.isInteger(k) || k < 0) {
      throw new RangeError('k must be a non-negative integer');
    }
    this.plan = plan;
    this.m = plan.length;
    this.k = k;
    this.INF = k + 1;
    this.prev = new Int32Array(this.m + 1).fill(this.INF);
    this.curr = new Int32Array(this.m + 1).fill(this.INF);
    // Row 0: the empty live prefix matches the empty planned prefix for
    // free; reaching planned prefix j costs j insertions (only j <= k can
    // stay within budget).
    const hi0 = Math.min(this.m, k);
    for (let j = 0; j <= hi0; j++) this.prev[j] = j;
  }

  /**
   * Commit one live cue: compute row n+1 from row n and refresh the
   * boundary. Called from the session's atomic commit section, so a
   * rejected command never reaches here and the frontier advances exactly
   * once per accepted cue.
   */
  append(cue: number): void {
    const k = this.k;
    const m = this.m;
    const INF = this.INF;
    const i = this.n + 1;

    const lo = Math.max(0, i - k);
    const hi = Math.min(m, i + k);

    // The two rows are RECYCLED (unlike distance.ts, which allocates fresh
    // rows). Every `curr` cell read by the recurrence that this row does not
    // overwrite must therefore hold the "> k" sentinel: the only such cell
    // is curr[lo - 1], the "insert" predecessor at the lower-left edge. The
    // small reset windows below also clear values row i - 2 (curr's previous
    // owner) wrote just outside this row's band while the band was still
    // widening (i <= k) or after it is clipped by m. They are empty in the
    // steady section, so one cue stays O(k); nothing on the right edge needs
    // resetting because every in-band cell up to hi is rewritten below.
    // `prev` needs no reset either: for every in-band j, prev[j - 1] and
    // prev[j] either lie inside row i-1's band or were never written by any
    // earlier row (the band only advances), hence already read as INF.
    const prevBandLo = Math.max(0, i - 2 - k);
    for (let j = prevBandLo; j < lo; j++) this.curr[j] = INF;
    const prevBandHi = Math.min(m, i - 2 + k);
    for (let j = hi + 1; j <= prevBandHi; j++) this.curr[j] = INF;
    // Edge sentinels for this row.
    if (lo === 0) {
      // j = 0 is a real band cell (deleting i live cues) while i <= k;
      // once i > k the band starts at j >= 1 and there is no j = 0 cell.
      if (i <= k) this.curr[0] = i;
    } else {
      this.curr[lo - 1] = INF;
    }
    if (hi < m) this.curr[hi + 1] = INF;

    let rowMin = lo === 0 && i <= k ? this.curr[0] : INF;
    for (let j = Math.max(1, lo); j <= hi; j++) {
      // Every j in this row's band (|i - j| <= k) has its diagonal
      // predecessor (i-1, j-1) inside the previous row's band too
      // (|(i-1) - (j-1)| = |i - j| <= k), so prev[j-1] always holds a real
      // row i-1 value here.
      let best: number = this.prev[j - 1] + (cue === this.plan[j - 1] ? 0 : 2);
      const del = this.prev[j] + 1; // delete the live cue
      if (del < best) best = del;
      const ins = this.curr[j - 1] + 1; // insert the planned cue
      if (ins < best) best = ins;
      const v = best > INF ? INF : best;
      this.curr[j] = v;
      if (v < rowMin) rowMin = v;
    }

    const swap = this.prev;
    this.prev = this.curr;
    this.curr = swap;

    this.n = i;
    // min_j D_i(j) is non-decreasing in i on its own (each row dominates
    // the previous one), so the row minimum is already the sticky boundary.
    this.boundary = rowMin;
  }

  /**
   * Seal the verdict against the whole plan: D_n(m), exact when <= k and an
   * exceeded signal otherwise. Idempotent — ending from either running or
   * paused reports the same final comparison.
   */
  finalize(): FinalVerdict {
    if (this.finalSnapshot) return this.finalSnapshot;
    // The final cell (n, m) is only written while it is in the band, i.e.
    // |n - m| <= k. A live run that overshot the plan by more than k left
    // that cell unwritten (its value is necessarily > k anyway).
    if (Math.abs(this.n - this.m) > this.k) {
      this.finalSnapshot = { status: 'exceeded' };
      return this.finalSnapshot;
    }
    const d = this.prev[this.m];
    this.finalSnapshot =
      d <= this.k ? { status: 'ok', distance: d } : { status: 'exceeded' };
    return this.finalSnapshot;
  }

  snapshot(): DeviationSnapshot {
    return {
      k: this.k,
      plannedLength: this.m,
      liveLength: this.n,
      boundary: this.boundary,
      recoverable: this.boundary <= this.k,
      final: this.finalSnapshot
        ? { ...this.finalSnapshot }
        : null,
    };
  }
}
