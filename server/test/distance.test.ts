import { describe, expect, it } from 'vitest';
import { boundedCueDistance } from '../src/distance.js';

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

function expectDistance(
  a: number[],
  b: number[],
  k: number,
  expected: number | 'exceeded',
): void {
  const result = boundedCueDistance(a, b, k);
  if (expected === 'exceeded') {
    expect(result).toEqual({ status: 'exceeded' });
  } else {
    expect(result).toEqual({ status: 'ok', distance: expected });
  }
}

/** Reference O(n*m) edit distance (ins=1, del=1, sub=2) for small inputs. */
function referenceDistance(a: number[], b: number[]): number {
  const n = a.length;
  const m = b.length;
  const d: number[][] = [];
  for (let i = 0; i <= n; i++) {
    d.push(new Array<number>(m + 1));
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
  return d[n][m];
}

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('boundedCueDistance — specified edge cases', () => {
  it('two empty sequences have distance 0', () => {
    expectDistance([], [], 0, 0);
    expectDistance([], [], 500, 0);
  });

  it('empty vs non-empty costs one insertion per element', () => {
    expectDistance([], [7, 8, 9], 3, 3);
    expectDistance([], [7, 8, 9], 500, 3);
    expectDistance([7, 8, 9], [], 3, 3);
    expectDistance([], [7, 8, 9], 2, 'exceeded');
  });

  it('identical sequences have distance 0, even with k = 0', () => {
    expectDistance([4, 4, 4], [4, 4, 4], 0, 0);
    expectDistance([1, 2, 3], [1, 2, 3], 500, 0);
  });

  it('k = 0 rejects any difference', () => {
    expectDistance([1, 2, 3], [1, 2, 4], 0, 'exceeded');
    expectDistance([1, 2], [1, 2, 3], 0, 'exceeded');
  });

  it('a substitution costs exactly 2', () => {
    expectDistance([1], [2], 2, 2);
    expectDistance([1], [2], 1, 'exceeded');
    expectDistance([1, 2, 3], [1, 9, 3], 2, 2);
  });

  it('single insertion or deletion costs 1', () => {
    expectDistance([1, 2, 3], [1, 3], 1, 1);
    expectDistance([1, 3], [1, 2, 3], 1, 1);
    expectDistance([1, 2, 3], [1, 3], 0, 'exceeded');
  });

  it('duplicate cues align to the cheapest copy', () => {
    expectDistance([7, 7, 7], [7, 7], 1, 1);
    expectDistance([7, 7], [7, 7, 7], 1, 1);
    expectDistance([1, 2, 1, 2], [2, 1, 2, 1], 2, 2);
    expectDistance([5, 5, 5, 5], [5, 5], 2, 2);
  });

  it('consecutive missing cues at the head', () => {
    expectDistance([1, 2, 3, 4, 5], [4, 5], 3, 3);
    expectDistance([1, 2, 3, 4, 5], [4, 5], 2, 'exceeded');
  });

  it('consecutive missing cues at the tail', () => {
    expectDistance([1, 2, 3, 4, 5], [1, 2], 3, 3);
    expectDistance([1, 2, 3, 4, 5], [1, 2], 2, 'exceeded');
  });

  it('length gap larger than k is exceeded without further work', () => {
    const a = Array.from({ length: 10 }, (_, i) => i);
    expectDistance(a, a.slice(0, 2), 7, 'exceeded');
    expectDistance(a.slice(0, 2), a, 7, 'exceeded');
    // Gap exactly k, pure tail truncation: exact distance equals the gap.
    expectDistance(a, a.slice(0, 2), 8, 8);
  });

  it('boundary: distance exactly k is reported, k - 1 is exceeded', () => {
    // Three substitutions => distance 6.
    expectDistance([1, 2, 3], [4, 5, 6], 6, 6);
    expectDistance([1, 2, 3], [4, 5, 6], 5, 'exceeded');
  });

  it('reversed sequences keep only one common cue', () => {
    // LCS = 1 => distance = 5 + 5 - 2 = 8.
    expectDistance([1, 2, 3, 4, 5], [5, 4, 3, 2, 1], 8, 8);
    expectDistance([1, 2, 3, 4, 5], [5, 4, 3, 2, 1], 7, 'exceeded');
  });

  it('compares elements by integer equality, including int32 extremes', () => {
    expectDistance([INT32_MIN, INT32_MAX], [INT32_MIN, INT32_MAX], 0, 0);
    expectDistance([INT32_MIN], [INT32_MAX], 2, 2);
    expectDistance([INT32_MIN], [INT32_MAX], 1, 'exceeded');
    expectDistance([0], [-0], 0, 0);
  });

  it('rejects a negative k', () => {
    expect(() => boundedCueDistance([], [], -1)).toThrow(RangeError);
  });
});

describe('boundedCueDistance — agreement with full DP on random inputs', () => {
  it('matches the reference distance for hundreds of small cases', () => {
    const rand = mulberry32(20260917);
    for (let trial = 0; trial < 600; trial++) {
      const alphabet = 2 + Math.floor(rand() * 7); // small alphabets force duplicates
      const lenA = Math.floor(rand() * 41);
      const lenB = Math.floor(rand() * 41);
      const a = Array.from({ length: lenA }, () => Math.floor(rand() * alphabet));
      const b = Array.from({ length: lenB }, () => Math.floor(rand() * alphabet));
      const k = Math.floor(rand() * 15);
      const exact = referenceDistance(a, b);
      expectDistance(a, b, k, exact <= k ? exact : 'exceeded');
    }
  });

  it('matches the reference on mutation-derived pairs', () => {
    const rand = mulberry32(42);
    for (let trial = 0; trial < 300; trial++) {
      const len = Math.floor(rand() * 45);
      const a = Array.from({ length: len }, () => Math.floor(rand() * 10));
      const b = a.slice();
      // Apply random sparse edits to b.
      const edits = Math.floor(rand() * 12);
      for (let e = 0; e < edits; e++) {
        const op = Math.floor(rand() * 3);
        const pos = b.length === 0 ? 0 : Math.floor(rand() * b.length);
        if (op === 0 && b.length > 0) b.splice(pos, 1);
        else if (op === 1) b.splice(pos, 0, Math.floor(rand() * 10));
        else if (b.length > 0) b[pos] = Math.floor(rand() * 10);
      }
      const k = Math.floor(rand() * 20);
      const exact = referenceDistance(a, b);
      expectDistance(a, b, k, exact <= k ? exact : 'exceeded');
    }
  });
});

describe('boundedCueDistance — 50k scale within budget', () => {
  const N = 50_000;

  function buildSparsePair(): { a: number[]; b: number[] } {
    // 100 deletions + 100 insertions + 50 substitutions (x2) = distance 300.
    const a = Array.from({ length: N }, (_, i) => i + 1);
    const del = new Set<number>();
    for (let d = 0; d < 100; d++) del.add(499 + d * 500);
    const sub = new Map<number, number>();
    for (let s = 0; s < 50; s++) sub.set(250 + s * 500, 2_000_000 + s);
    const insAfter = new Map<number, number>();
    for (let t = 0; t < 100; t++) insAfter.set(374 + t * 500, 1_000_000 + t);
    const b: number[] = [];
    for (let i = 0; i < N; i++) {
      if (del.has(i)) continue;
      b.push(sub.get(i) ?? a[i]);
      const ins = insAfter.get(i);
      if (ins !== undefined) b.push(ins);
    }
    return { a, b };
  }

  it('returns the exact distance for sparse edits at 50k items', { timeout: 30_000 }, () => {
    const { a, b } = buildSparsePair();
    expect(a.length).toBe(N);
    expect(b.length).toBe(N);
    expectDistance(a, b, 500, 300);
    expectDistance(a, b, 300, 300);
    expectDistance(a, b, 299, 'exceeded');
  });

  it('distance exactly k = 500 is reported, 502 is exceeded', { timeout: 30_000 }, () => {
    const a = Array.from({ length: N }, (_, i) => i + 1);
    const b500 = a.slice();
    for (let s = 0; s < 250; s++) b500[100 + s * 199] = 3_000_000 + s; // 250 subs = 500
    expectDistance(a, b500, 500, 500);
    const b502 = a.slice();
    for (let s = 0; s < 251; s++) b502[50 + s * 199] = 4_000_000 + s; // 251 subs = 502
    expectDistance(a, b502, 500, 'exceeded');
  });

  it('length gap of 501 exceeds k = 500 immediately', () => {
    const a = Array.from({ length: N }, (_, i) => i + 1);
    expectDistance(a, a.slice(0, N - 501), 500, 'exceeded');
    expectDistance(a.slice(0, N - 501), a, 500, 'exceeded');
  });

  it('handles int32 extremes at scale', { timeout: 30_000 }, () => {
    const a = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? INT32_MIN : INT32_MAX));
    const b = a.slice();
    b[0] = INT32_MAX; // one substitution => 2
    b.push(INT32_MIN); // one insertion => 1
    expectDistance(a, b, 500, 3);
    expectDistance(a, b, 2, 'exceeded');
  });
});
