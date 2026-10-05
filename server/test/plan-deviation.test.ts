import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Performance } from '../src/performance.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function sendCommand(payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/performances/commands',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

async function getPerformance(id: string) {
  return app.inject({ method: 'GET', url: `/api/performances/${id}` });
}

let seq = 0;
function rid(label: string): string {
  seq += 1;
  return `plan-${label}-${seq}`;
}

async function createPlanned(
  name: string,
  planCues: number[] | undefined,
  k?: number,
  id = rid('create'),
): Promise<Performance> {
  const payload: Record<string, unknown> = { command: 'create', name, requestId: id };
  if (planCues !== undefined) payload.planCues = planCues;
  if (k !== undefined) payload.k = k;
  const res = await sendCommand(payload);
  expect(res.statusCode).toBe(200);
  return res.json().performance as Performance;
}

async function start(id: string, version: number, label: string) {
  const res = await sendCommand({
    command: 'transition',
    performanceId: id,
    status: 'running',
    expectedVersion: version,
    requestId: rid(label),
  });
  expect(res.statusCode).toBe(200);
  return res.json().performance as Performance;
}

async function cue(id: string, value: number, version: number, label: string) {
  return sendCommand({
    command: 'registerCue',
    performanceId: id,
    cue: value,
    expectedVersion: version,
    requestId: rid(label),
  });
}

describe('planned session — snapshot shape at creation', () => {
  it('seals the plan and reports the zero-cue boundary without a final verdict', async () => {
    const s = await createPlanned('晚场-带计划', [101, 102, 103], 2);
    expect(s).toMatchObject({
      status: 'pending',
      version: 1,
      plan: { cues: [101, 102, 103], k: 2 },
      deviation: {
        k: 2,
        plannedLength: 3,
        liveLength: 0,
        boundary: 0,
        recoverable: true,
        final: null,
      },
    });
    // The GET snapshot carries the identical sealed plan and state.
    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.plan).toEqual({ cues: [101, 102, 103], k: 2 });
    expect(loaded.deviation).toMatchObject({ liveLength: 0, boundary: 0, final: null });
  });

  it('accepts an empty planned cue array', async () => {
    const s = await createPlanned('空计划', [], 1);
    expect(s.plan).toEqual({ cues: [], k: 1 });
    expect(s.deviation?.plannedLength).toBe(0);
  });
});

describe('planned session — per-cue boundary and the final verdict', () => {
  it('walks recoverable -> unrecoverable cue by cue, and sealing compares the whole plan', async () => {
    // plan [1,2,3,4], k = 1; two stray cues 9 and 8 cannot both be deleted.
    const s = await createPlanned('逐条边界', [1, 2, 3, 4], 1);
    await start(s.id, 1, 'start');

    // Two exact cues: boundary stays 0.
    let r = await cue(s.id, 1, 2, 'c1');
    let p = r.json().performance;
    expect(p.version).toBe(3);
    expect(p.deviation).toMatchObject({ liveLength: 1, boundary: 0, recoverable: true, final: null });

    r = await cue(s.id, 2, 3, 'c2');
    p = r.json().performance;
    expect(p.deviation).toMatchObject({ liveLength: 2, boundary: 0, recoverable: true });

    // One stray cue 9 can still be deleted (align with prefix [1,2]):
    // boundary 1, still recoverable.
    r = await cue(s.id, 9, 4, 'c3');
    p = r.json().performance;
    expect(p.deviation).toMatchObject({ liveLength: 3, boundary: 1, recoverable: true });

    // A second stray cue 8 pushes every prefix over k: unrecoverable.
    r = await cue(s.id, 8, 5, 'c4');
    p = r.json().performance;
    expect(p.version).toBe(6);
    expect(p.deviation.boundary).toBeGreaterThan(1);
    expect(p.deviation.recoverable).toBe(false);
    expect(p.cues).toEqual([1, 2, 9, 8]);

    // Continuing perfectly afterwards cannot bring it back.
    r = await cue(s.id, 3, 6, 'c5');
    p = r.json().performance;
    expect(p.deviation.recoverable).toBe(false);
    r = await cue(s.id, 4, 7, 'c6');
    p = r.json().performance;
    expect(p.deviation.recoverable).toBe(false);

    // Seal: deleting the two stray cues costs 2 > k = 1 -> exceeded.
    const end = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 8,
      requestId: rid('end'),
    });
    const ended = end.json().performance;
    expect(end.statusCode).toBe(200);
    expect(ended.status).toBe('ended');
    expect(ended.deviation.final).toEqual({ status: 'exceeded' });
    expect(ended.deviation).not.toHaveProperty('distance');
  });

  it('reports an exact final distance when the whole-plan comparison is within k', async () => {
    // One extra live cue -> exactly one deletion at the end.
    const s = await createPlanned('可追回', [101, 102, 103], 2);
    await start(s.id, 1, 'start');
    for (const [i, value] of [101, 102, 205, 103].entries()) {
      const r = await cue(s.id, value, 2 + i, `cue-${i}`);
      expect(r.statusCode).toBe(200);
      expect(r.json().performance.deviation.recoverable).toBe(true);
    }
    const end = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 6,
      requestId: rid('end'),
    });
    expect(end.json().performance.deviation.final).toEqual({ status: 'ok', distance: 1 });
  });

  it('distinguishes a recoverable mid-show boundary from an exceeded whole-plan final', async () => {
    // The stage manager stops three cues early: every prefix heard matches
    // the plan exactly (boundary 0) but the two unheard planned cues cost 2.
    const s = await createPlanned('提前结束', [1, 2, 3, 4, 5], 1);
    await start(s.id, 1, 'start');
    for (const [i, value] of [1, 2, 3].entries()) {
      const r = await cue(s.id, value, 2 + i, `cue-${i}`);
      expect(r.json().performance.deviation).toMatchObject({
        boundary: 0,
        recoverable: true,
        final: null,
      });
    }
    const end = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 5,
      requestId: rid('end'),
    });
    const ended = end.json().performance;
    expect(ended.deviation.final).toEqual({ status: 'exceeded' });
  });

  it('marks the very first off-plan cue unrecoverable when k = 0 and keeps it sticky', async () => {
    const s = await createPlanned('零容忍', [1, 2], 0);
    await start(s.id, 1, 'start');
    let r = await cue(s.id, 1, 2, 'ok');
    expect(r.json().performance.deviation).toMatchObject({ boundary: 0, recoverable: true });
    r = await cue(s.id, 9, 3, 'bad');
    expect(r.json().performance.deviation.recoverable).toBe(false);
    // Back on the plan: stays unrecoverable.
    r = await cue(s.id, 2, 4, 'late');
    expect(r.json().performance.deviation.recoverable).toBe(false);
  });

  it('treats every live cue as a deletion against an empty plan', async () => {
    const s = await createPlanned('空计划现场', [], 1);
    await start(s.id, 1, 'start');
    let r = await cue(s.id, 7, 2, 'c1');
    expect(r.json().performance.deviation).toMatchObject({ boundary: 1, recoverable: true });
    r = await cue(s.id, 8, 3, 'c2');
    expect(r.json().performance.deviation.boundary).toBeGreaterThan(1);
    expect(r.json().performance.deviation.recoverable).toBe(false);
  });
});

describe('planned session — rejections and replays never advance the distance state', () => {
  it('VERSION_CONFLICT cue leaves cues, boundary, liveLength and version untouched', async () => {
    const s = await createPlanned('冲突不推进', [1, 2], 1);
    await start(s.id, 1, 'start');
    const ok = await cue(s.id, 1, 2, 'good');
    expect(ok.statusCode).toBe(200);
    const before = ok.json().performance;
    expect(before.deviation).toMatchObject({ liveLength: 1, boundary: 0 });

    const stale = await cue(s.id, 2, 2, 'stale'); // current version is 3
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.reason).toBe('VERSION_CONFLICT');

    const loaded = (await getPerformance(s.id)).json().performance;
    expect(loaded.version).toBe(3);
    expect(loaded.cues).toEqual([1]);
    expect(loaded.deviation).toMatchObject({ liveLength: 1, boundary: 0, recoverable: true });
  });

  it('NOT_RUNNING cue while paused does not move the frontier; resume then continues it', async () => {
    const s = await createPlanned('暂停不推进', [1, 2, 3], 2);
    await start(s.id, 1, 'start');
    await cue(s.id, 1, 2, 'c1');
    const pause = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'paused',
      expectedVersion: 3,
      requestId: rid('pause'),
    });
    expect(pause.statusCode).toBe(200);
    const paused = pause.json().performance;
    // The pause transition freezes the frontier and produces no verdict.
    expect(paused.deviation).toMatchObject({ liveLength: 1, boundary: 0, final: null });

    const whilePaused = await cue(s.id, 2, 4, 'while-paused');
    expect(whilePaused.statusCode).toBe(409);
    expect(whilePaused.json().error.reason).toBe('NOT_RUNNING');

    const resume = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 4,
      requestId: rid('resume'),
    });
    expect(resume.json().performance.deviation.liveLength).toBe(1);

    // The cue rejected during the pause commits after resume and advances.
    const after = await cue(s.id, 2, 5, 'after-resume');
    expect(after.statusCode).toBe(200);
    expect(after.json().performance.deviation).toMatchObject({ liveLength: 2, boundary: 0 });

    // Sealing straight from a pause is also allowed and yields the verdict.
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'paused',
      expectedVersion: 6,
      requestId: rid('pause2'),
    });
    const end = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 7,
      requestId: rid('end-from-paused'),
    });
    expect(end.json().performance.deviation.final).toEqual({ status: 'ok', distance: 1 });
  });

  it('a replayed / duplicate request id never advances the frontier', async () => {
    const s = await createPlanned('重放不推进', [1], 1);
    await start(s.id, 1, 'start');
    const committed = await cue(s.id, 1, 2, 'shared');
    expect(committed.statusCode).toBe(200);
    const v = committed.json().performance.version;

    const replay = await sendCommand({
      command: 'registerCue',
      performanceId: s.id,
      cue: 9,
      expectedVersion: v,
      requestId: committed.json().performance.requestId,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.reason).toBe('DUPLICATE_REQUEST');

    const loaded = (await getPerformance(s.id)).json().performance;
    expect(loaded.cues).toEqual([1]);
    expect(loaded.deviation.liveLength).toBe(1);
    expect(loaded.version).toBe(v);
  });

  it('a request id rejected for the precondition is still reusable and then advances once', async () => {
    const s = await createPlanned('拒绝后复用', [1], 1);
    await start(s.id, 1, 'start');
    const envelope = {
      command: 'registerCue',
      performanceId: s.id,
      cue: 1,
      expectedVersion: 3,
      requestId: 'rejected-then-ok',
    };
    // Pause first (running v2 -> paused v3) so the write is NOT_RUNNING.
    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'paused',
      expectedVersion: 2,
      requestId: rid('pause'),
    });
    const rejected = await sendCommand(envelope);
    expect(rejected.json().error.reason).toBe('NOT_RUNNING');
    expect((await getPerformance(s.id)).json().performance.deviation.liveLength).toBe(0);

    await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'running',
      expectedVersion: 3,
      requestId: rid('resume'),
    });
    envelope.expectedVersion = 4;
    const retried = await sendCommand(envelope);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().performance.deviation).toMatchObject({ liveLength: 1, boundary: 0 });
  });
});

describe('planned sessions — plan immutability and cross-session isolation', () => {
  it('the sealed plan is echoed identically by every later snapshot', async () => {
    const s = await createPlanned('封存计划', [10, 20, 30], 3);
    await start(s.id, 1, 'start');
    await cue(s.id, 10, 2, 'c1');
    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.plan).toEqual({ cues: [10, 20, 30], k: 3 });
  });

  it('two sessions keep independent plans and frontiers', async () => {
    const a = await createPlanned('A 场', [1, 2], 0, rid('a'));
    const b = await createPlanned('B 场', [9, 8, 7], 5, rid('b'));
    await start(a.id, 1, 'a-start');
    await start(b.id, 1, 'b-start');

    const ra = await cue(a.id, 5, 2, 'a-bad'); // off plan with k = 0
    expect(ra.json().performance.deviation.recoverable).toBe(false);

    const rb = await cue(b.id, 9, 2, 'b-good');
    expect(rb.json().performance.deviation).toMatchObject({
      plannedLength: 3,
      liveLength: 1,
      boundary: 0,
      recoverable: true,
    });

    const snapA = (await getPerformance(a.id)).json().performance;
    const snapB = (await getPerformance(b.id)).json().performance;
    expect(snapA.plan).toEqual({ cues: [1, 2], k: 0 });
    expect(snapB.plan).toEqual({ cues: [9, 8, 7], k: 5 });
  });
});

describe('legacy sessions (no plan at creation) keep the original flow', () => {
  it('has null plan and deviation through the whole lifecycle', async () => {
    const s = await createPlanned('旧场次', undefined);
    expect(s.plan).toBeNull();
    expect(s.deviation).toBeNull();
    await start(s.id, 1, 'start');

    const r = await cue(s.id, 101, 2, 'cue');
    expect(r.statusCode).toBe(200);
    const running = r.json().performance;
    expect(running.cues).toEqual([101]);
    expect(running.plan).toBeNull();
    expect(running.deviation).toBeNull();

    const end = await sendCommand({
      command: 'transition',
      performanceId: s.id,
      status: 'ended',
      expectedVersion: 3,
      requestId: rid('end'),
    });
    expect(end.json().performance).toMatchObject({ status: 'ended', plan: null, deviation: null });

    const loaded = (await getPerformance(s.id)).json().performance;
    expect(loaded.plan).toBeNull();
    expect(loaded.deviation).toBeNull();
  });
});

describe('planned session — same-version concurrency advances the frontier once', () => {
  it('of five concurrent cues exactly one commits and the boundary moves a single step', async () => {
    const s = await createPlanned('并发计划', [1, 2, 3, 4, 5], 2);
    await start(s.id, 1, 'start'); // v2 running

    const burst = await Promise.all(
      [1, 9, 7, 2, 4].map((value, i) =>
        sendCommand({
          command: 'registerCue',
          performanceId: s.id,
          cue: value,
          expectedVersion: 2,
          requestId: `plan-conc-${i}-${rid('burst')}`,
        }),
      ),
    );
    const committed = burst.filter((r) => r.statusCode === 200);
    const conflicts = burst.filter(
      (r) => r.statusCode === 409 && r.json().error.reason === 'VERSION_CONFLICT',
    );
    expect(committed).toHaveLength(1);
    expect(conflicts).toHaveLength(4);

    const loaded = (await getPerformance(s.id)).json().performance;
    expect(loaded.version).toBe(3);
    expect(loaded.cues).toHaveLength(1);
    // Exactly one frontier step: one live cue, whatever its value.
    expect(loaded.deviation.liveLength).toBe(1);
    expect(loaded.deviation.boundary).toBe(committed[0]!.json().performance.deviation.boundary);
  });
});

describe('planned session — envelope validation', () => {
  async function createRaw(extra: Record<string, unknown>) {
    return sendCommand({ command: 'create', name: '校验', requestId: rid('raw'), ...extra });
  }

  it('requires planCues and k together', async () => {
    let r = await createRaw({ planCues: [1, 2] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_BODY');

    r = await createRaw({ k: 2 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_BODY');

    r = await createRaw({ planCues: null, k: 2 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_BODY');
  });

  it('rejects bad plan elements, overlong arrays and out-of-range k with stable codes', async () => {
    let r = await createRaw({ planCues: [1, '2'], k: 2 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_ELEMENT');

    r = await createRaw({ planCues: [1.5], k: 2 });
    expect(r.json().error.code).toBe('INVALID_ELEMENT');

    r = await createRaw({ planCues: [2147483648], k: 2 });
    expect(r.json().error.code).toBe('INVALID_ELEMENT');

    r = await createRaw({ planCues: new Array(50_001).fill(0), k: 2 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('ARRAY_TOO_LONG');

    for (const badK of [-1, 501, 1.5, '3']) {
      r = await createRaw({ planCues: [], k: badK });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('INVALID_K');
    }
  });

  it('accepts a valid plan (including int32 extremes)', async () => {
    const r = await createRaw({ planCues: [-2147483648, 0, 2147483647], k: 0 });
    expect(r.statusCode).toBe(200);
    expect(r.json().performance.plan).toEqual({
      cues: [-2147483648, 0, 2147483647],
      k: 0,
    });
  });
});
