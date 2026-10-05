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
  return `correct-${label}-${seq}`;
}

async function createSession(
  name: string,
  plan?: { cues: number[]; k: number },
): Promise<Performance> {
  const res = await sendCommand({
    command: 'create',
    name,
    requestId: rid('create'),
    ...(plan ? { planCues: plan.cues, k: plan.k } : {}),
  });
  expect(res.statusCode).toBe(200);
  return res.json().performance as Performance;
}

async function transition(
  id: string,
  status: string,
  expectedVersion: number,
  label: string,
) {
  const res = await sendCommand({
    command: 'transition',
    performanceId: id,
    status,
    expectedVersion,
    requestId: rid(label),
  });
  expect(res.statusCode).toBe(200);
  return res.json().performance as Performance;
}

async function register(id: string, cue: number, expectedVersion: number, label: string) {
  const res = await sendCommand({
    command: 'registerCue',
    performanceId: id,
    cue,
    expectedVersion,
    requestId: rid(label),
  });
  expect(res.statusCode).toBe(200);
  return res.json().performance as Performance;
}

function correct(
  id: string,
  position: number,
  expectedOldValue: number,
  cue: number,
  expectedVersion: number,
  requestId = rid('correct'),
) {
  return sendCommand({
    command: 'correctCue',
    performanceId: id,
    position,
    expectedOldValue,
    cue,
    expectedVersion,
    requestId,
  });
}

function expectRejected(body: any, reason: string) {
  expect(body.error.code).toBe('COMMAND_REJECTED');
  expect(body.error.reason).toBe(reason);
}

describe('correctCue — consecutive corrections rebuild the prefix deviation', () => {
  it('two merged corrections turn "exceeded" back into "recoverable" and the end verdict uses the corrected sequence', async () => {
    // plan [1,2,3,4], k = 1; live 1,2,9,8 crosses the budget at the 4th cue.
    const s = await createSession('合流更正', { cues: [1, 2, 3, 4], k: 1 });
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await register(s.id, 2, 3, 'c2');
    await register(s.id, 9, 4, 'c3');
    const stray = await register(s.id, 8, 5, 'c4');
    expect(stray.deviation).toMatchObject({ liveLength: 4, recoverable: false });
    expect(stray.deviation!.boundary).toBeGreaterThan(1);

    await transition(s.id, 'paused', 6, 'pause');

    // First correction: 9 -> 3. Candidate [1,2,3,8] is one deletion away
    // from plan prefix [1,2,3]: boundary 1 <= k, recoverable again. The old
    // sticky frontier (already > k) must not be reused.
    const first = await correct(s.id, 2, 9, 3, 7);
    expect(first.statusCode).toBe(200);
    const p1 = first.json().performance as Performance;
    expect(p1.version).toBe(8);
    expect(p1.cues).toEqual([1, 2, 3, 8]); // timeline shows effective values
    expect(p1.deviation).toMatchObject({
      liveLength: 4,
      boundary: 1,
      recoverable: true,
      final: null,
    });
    expect(p1.corrections).toEqual([
      {
        position: 2,
        oldValue: 9,
        newValue: 3,
        version: 8,
        requestId: p1.corrections[0]!.requestId,
      },
    ]);

    // Second correction merges on top: 8 -> 4. Candidate [1,2,3,4] matches
    // the plan exactly.
    const second = await correct(s.id, 3, 8, 4, 8);
    expect(second.statusCode).toBe(200);
    const p2 = second.json().performance as Performance;
    expect(p2.version).toBe(9);
    expect(p2.cues).toEqual([1, 2, 3, 4]);
    expect(p2.deviation).toMatchObject({ boundary: 0, recoverable: true });
    expect(p2.corrections).toHaveLength(2);
    expect(p2.corrections[1]).toMatchObject({
      position: 3,
      oldValue: 8,
      newValue: 4,
      version: 9,
    });

    // The GET snapshot exposes the same audit record and effective timeline.
    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.cues).toEqual([1, 2, 3, 4]);
    expect(loaded.corrections).toHaveLength(2);
    expect(loaded.corrections[0]).toMatchObject({ position: 2, oldValue: 9, newValue: 3, version: 8 });
    expect(loaded.corrections[1]).toMatchObject({ position: 3, oldValue: 8, newValue: 4, version: 9 });

    // Sealing straight from paused: the final verdict compares the
    // CORRECTED sequence with the whole plan -> exact distance 0.
    const end = await transition(s.id, 'ended', 9, 'end');
    expect(end.version).toBe(10);
    expect(end.deviation?.final).toEqual({ status: 'ok', distance: 0 });
    // The corrections survive sealing, still viewable on the readonly session.
    expect(end.corrections).toHaveLength(2);
  });

  it('a correction that does not fully repair the plan keeps the honest boundary', async () => {
    // plan [1,2,3,4], k = 1; live [9,9,9,9] is far off. Correcting one cue
    // helps but cannot bring the boundary back within k.
    const s = await createSession('部分修复', { cues: [1, 2, 3, 4], k: 1 });
    await transition(s.id, 'running', 1, 'start');
    for (const [i, cue] of [9, 9, 9, 9].entries()) {
      await register(s.id, cue, 2 + i, `c${i}`);
    }
    await transition(s.id, 'paused', 6, 'pause');
    const res = await correct(s.id, 0, 9, 1, 7);
    expect(res.statusCode).toBe(200);
    const p = res.json().performance as Performance;
    expect(p.cues).toEqual([1, 9, 9, 9]);
    expect(p.deviation?.recoverable).toBe(false);
    expect(p.deviation?.boundary).toBeGreaterThan(1);
  });
});

describe('correctCue — pause boundary', () => {
  it('rejects corrections while pending, running and ended with NOT_PAUSED', async () => {
    const s = await createSession('暂停边界', { cues: [1, 2], k: 1 });

    const whilePending = await correct(s.id, 0, 1, 5, 1);
    expect(whilePending.statusCode).toBe(409);
    expectRejected(whilePending.json(), 'NOT_PAUSED');

    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');

    const whileRunning = await correct(s.id, 0, 1, 5, 3);
    expect(whileRunning.statusCode).toBe(409);
    expectRejected(whileRunning.json(), 'NOT_PAUSED');

    await transition(s.id, 'paused', 3, 'pause');
    const ok = await correct(s.id, 0, 1, 5, 4);
    expect(ok.statusCode).toBe(200);

    await transition(s.id, 'ended', 5, 'end');
    const whileEnded = await correct(s.id, 0, 5, 1, 6);
    expect(whileEnded.statusCode).toBe(409);
    expectRejected(whileEnded.json(), 'NOT_PAUSED');

    // Nothing but the single committed correction ever landed.
    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.cues).toEqual([5]);
    expect(loaded.corrections).toHaveLength(1);
    expect(loaded.version).toBe(6);
  });

  it('still rejects cue registration while paused (NOT_RUNNING is unchanged)', async () => {
    const s = await createSession('暂停登记', { cues: [1], k: 0 });
    await transition(s.id, 'running', 1, 'start');
    await transition(s.id, 'paused', 2, 'pause');
    const res = await sendCommand({
      command: 'registerCue',
      performanceId: s.id,
      cue: 1,
      expectedVersion: 3,
      requestId: rid('paused-register'),
    });
    expect(res.statusCode).toBe(409);
    expectRejected(res.json(), 'NOT_RUNNING');
  });
});

describe('correctCue — position and old-value checks', () => {
  it('rejects out-of-range positions with INVALID_POSITION and changes nothing', async () => {
    const s = await createSession('位置越界', { cues: [1, 2, 3], k: 2 });
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await transition(s.id, 'paused', 3, 'pause');

    for (const position of [1, 5, 100]) {
      const res = await correct(s.id, position, 1, 9, 4);
      expect(res.statusCode).toBe(409);
      expectRejected(res.json(), 'INVALID_POSITION');
    }

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.cues).toEqual([1]);
    expect(loaded.corrections).toEqual([]);
    expect(loaded.version).toBe(4);
  });

  it('rejects a wrong expected old value with OLD_VALUE_MISMATCH', async () => {
    const s = await createSession('旧值不符', { cues: [1, 2], k: 1 });
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await transition(s.id, 'paused', 3, 'pause');

    const res = await correct(s.id, 0, 999, 5, 4);
    expect(res.statusCode).toBe(409);
    expectRejected(res.json(), 'OLD_VALUE_MISMATCH');

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.cues).toEqual([1]);
    expect(loaded.corrections).toEqual([]);
    expect(loaded.version).toBe(4);
  });

  it('correcting the same position twice requires the value committed by the first correction', async () => {
    const s = await createSession('同位连改', { cues: [5], k: 0 });
    await transition(s.id, 'running', 1, 'start');
    const stray = await register(s.id, 9, 2, 'c1');
    expect(stray.deviation?.recoverable).toBe(false);
    await transition(s.id, 'paused', 3, 'pause');

    // 9 -> 7: commits but still off plan (k = 0).
    const first = await correct(s.id, 0, 9, 7, 4);
    expect(first.statusCode).toBe(200);
    expect(first.json().performance.deviation.recoverable).toBe(false);

    // The superseded value 9 is no longer the effective one.
    const staleOld = await correct(s.id, 0, 9, 5, 5);
    expect(staleOld.statusCode).toBe(409);
    expectRejected(staleOld.json(), 'OLD_VALUE_MISMATCH');

    // 7 -> 5 with the current effective value: commits, boundary 0.
    const second = await correct(s.id, 0, 7, 5, 5);
    expect(second.statusCode).toBe(200);
    const p = second.json().performance as Performance;
    expect(p.cues).toEqual([5]);
    expect(p.deviation).toMatchObject({ boundary: 0, recoverable: true });
    expect(p.corrections).toHaveLength(2);
    expect(p.corrections[0]).toMatchObject({ oldValue: 9, newValue: 7, version: 5 });
    expect(p.corrections[1]).toMatchObject({ oldValue: 7, newValue: 5, version: 6 });
  });
});

describe('correctCue — version conflicts and duplicate requests', () => {
  it('VERSION_CONFLICT leaves timeline, corrections, deviation and version untouched', async () => {
    const s = await createSession('更正冲突', { cues: [1, 2], k: 1 });
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await transition(s.id, 'paused', 3, 'pause');

    const stale = await correct(s.id, 0, 1, 9, 3); // current version is 4
    expect(stale.statusCode).toBe(409);
    expectRejected(stale.json(), 'VERSION_CONFLICT');

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.version).toBe(4);
    expect(loaded.cues).toEqual([1]);
    expect(loaded.corrections).toEqual([]);
    expect(loaded.deviation).toMatchObject({ liveLength: 1, boundary: 0 });
  });

  it('replaying a committed correction id is DUPLICATE_REQUEST with no side effects', async () => {
    const s = await createSession('更正重放', { cues: [1, 2], k: 1 });
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await transition(s.id, 'paused', 3, 'pause');

    const requestId = rid('committed-correction');
    const committed = await correct(s.id, 0, 1, 7, 4, requestId);
    expect(committed.statusCode).toBe(200);

    const replay = await correct(s.id, 0, 1, 7, 4, requestId);
    expect(replay.statusCode).toBe(409);
    expectRejected(replay.json(), 'DUPLICATE_REQUEST');

    // A replay retargeted at another session names the first owner.
    const other = await createSession('重放目标', { cues: [9], k: 1 });
    const foreign = await sendCommand({
      command: 'correctCue',
      performanceId: other.id,
      position: 0,
      expectedOldValue: 9,
      cue: 1,
      expectedVersion: 1,
      requestId,
    });
    expect(foreign.statusCode).toBe(409);
    expectRejected(foreign.json(), 'DUPLICATE_REQUEST');
    expect(foreign.json().error.message).toContain(s.id);

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.cues).toEqual([7]);
    expect(loaded.corrections).toHaveLength(1);
    expect(loaded.version).toBe(5);
  });

  it('a rejected correction does not burn its request id', async () => {
    const s = await createSession('拒绝复用', { cues: [1, 2], k: 1 });
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await transition(s.id, 'paused', 3, 'pause');

    const requestId = rid('rejected-then-ok');
    const stale = await correct(s.id, 0, 1, 9, 3, requestId); // stale version
    expect(stale.statusCode).toBe(409);
    expectRejected(stale.json(), 'VERSION_CONFLICT');

    const retried = await correct(s.id, 0, 1, 9, 4, requestId);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().performance).toMatchObject({
      version: 5,
      requestId,
      cues: [9],
    });
  });

  it('of two concurrent same-version corrections exactly one commits', async () => {
    const s = await createSession('并发更正', { cues: [1, 2], k: 1 });
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await transition(s.id, 'paused', 3, 'pause');

    const [a, b] = await Promise.all([
      correct(s.id, 0, 1, 101, 4),
      correct(s.id, 0, 1, 202, 4),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const conflicts = results.filter((r) => r.statusCode === 409);
    expect(conflicts).toHaveLength(1);
    expectRejected(conflicts[0]!.json(), 'VERSION_CONFLICT');

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.version).toBe(5);
    expect(loaded.corrections).toHaveLength(1);
    expect([101, 202]).toContain(loaded.cues[0]);
  });
});

describe('correctCue — sessions without a plan', () => {
  it('corrects the timeline and keeps the audit record without inventing deviation data', async () => {
    const s = await createSession('无计划更正');
    expect(s.plan).toBeNull();
    expect(s.deviation).toBeNull();
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 10, 2, 'c1');
    await register(s.id, 20, 3, 'c2');
    await transition(s.id, 'paused', 4, 'pause');

    const res = await correct(s.id, 0, 10, 11, 5);
    expect(res.statusCode).toBe(200);
    const p = res.json().performance as Performance;
    expect(p.cues).toEqual([11, 20]);
    expect(p.plan).toBeNull();
    expect(p.deviation).toBeNull();
    expect(p.corrections).toEqual([
      {
        position: 0,
        oldValue: 10,
        newValue: 11,
        version: 6,
        requestId: p.corrections[0]!.requestId,
      },
    ]);

    const end = await transition(s.id, 'ended', 6, 'end');
    expect(end.plan).toBeNull();
    expect(end.deviation).toBeNull();
    expect(end.corrections).toHaveLength(1);
  });
});

describe('correctCue — envelope validation', () => {
  it('rejects malformed positions with INVALID_BODY', async () => {
    const s = await createSession('位置校验');
    for (const position of [-1, 1.5, '0', null]) {
      const res = await sendCommand({
        command: 'correctCue',
        performanceId: s.id,
        position,
        expectedOldValue: 1,
        cue: 2,
        expectedVersion: 1,
        requestId: rid(`pos-${String(position)}`),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_BODY');
    }
  });

  it('rejects non-int32 cue and expectedOldValue with INVALID_CUE', async () => {
    const s = await createSession('数值校验');
    const base = {
      command: 'correctCue',
      performanceId: s.id,
      position: 0,
      expectedVersion: 1,
    };
    for (const cue of [1.5, '7', 2147483648, null]) {
      const res = await sendCommand({
        ...base,
        expectedOldValue: 1,
        cue,
        requestId: rid(`cue-${String(cue)}`),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CUE');
    }
    for (const expectedOldValue of [1.5, '7', -2147483649]) {
      const res = await sendCommand({
        ...base,
        expectedOldValue,
        cue: 2,
        requestId: rid(`old-${String(expectedOldValue)}`),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CUE');
    }
  });

  it('rejects missing fields with INVALID_BODY / INVALID_CUE and never touches state', async () => {
    const s = await createSession('缺字段');
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await transition(s.id, 'paused', 3, 'pause');

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ command: 'correctCue', position: 0, expectedOldValue: 1, cue: 2, expectedVersion: 4, requestId: rid('m1') }, 'INVALID_BODY'], // no performanceId
      [{ command: 'correctCue', performanceId: s.id, expectedOldValue: 1, cue: 2, expectedVersion: 4, requestId: rid('m2') }, 'INVALID_BODY'], // no position
      [{ command: 'correctCue', performanceId: s.id, position: 0, cue: 2, expectedVersion: 4, requestId: rid('m3') }, 'INVALID_CUE'], // no expectedOldValue
      [{ command: 'correctCue', performanceId: s.id, position: 0, expectedOldValue: 1, expectedVersion: 4, requestId: rid('m4') }, 'INVALID_CUE'], // no cue
      [{ command: 'correctCue', performanceId: s.id, position: 0, expectedOldValue: 1, cue: 2, requestId: rid('m5') }, 'INVALID_BODY'], // no expectedVersion
      [{ command: 'correctCue', performanceId: s.id, position: 0, expectedOldValue: 1, cue: 2, expectedVersion: 4 }, 'INVALID_BODY'], // no requestId
    ];
    for (const [payload, code] of cases) {
      const res = await sendCommand(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(code);
    }

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.version).toBe(4);
    expect(loaded.cues).toEqual([1]);
    expect(loaded.corrections).toEqual([]);
  });
});
