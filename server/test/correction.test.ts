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
  return `correction-${label}-${seq}`;
}

async function createSession(payload: Record<string, unknown>, label: string): Promise<Performance> {
  const res = await sendCommand({
    name: label,
    requestId: rid(`${label}-create`),
    ...payload,
  });
  expect(res.statusCode).toBe(200);
  return res.json().performance as Performance;
}

async function transition(id: string, status: Performance['status'], expectedVersion: number, label: string) {
  const res = await sendCommand({
    command: 'transition',
    performanceId: id,
    status,
    expectedVersion,
    requestId: rid(`transition-${label}-${expectedVersion}`),
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
    requestId: rid(`register-${label}-${expectedVersion}-${cue}`),
  });
  expect(res.statusCode).toBe(200);
  return res.json().performance as Performance;
}

function correct(id: string, payload: Record<string, unknown>, expectedVersion: number, label: string) {
  return sendCommand({
    command: 'correctCue',
    performanceId: id,
    expectedVersion,
    requestId: rid(`correct-${label}-${expectedVersion}-${JSON.stringify(payload)}`),
    ...payload,
  });
}

function expectRejected(body: any, reason: string) {
  expect(body.error.code).toBe('COMMAND_REJECTED');
  expect(body.error.reason).toBe(reason);
}

describe('correctCue — paused correction and audit trail', () => {
  it('rebuilds a planned prefix from the corrected timeline and records old/new/version', async () => {
    // With k=1 the two stray cues [9, 8] make the prefix unrecoverable.
    // Correcting 8 -> 3 rebuilds from scratch and allows recovery again.
    const s = await createSession(
      { command: 'create', planCues: [1, 2, 3, 4], k: 1 },
      '更正后追回',
    );
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await register(s.id, 2, 3, 'c2');
    await register(s.id, 9, 4, 'c3');
    const beforePause = await register(s.id, 8, 5, 'c4');
    expect(beforePause.deviation?.recoverable).toBe(false);

    const paused = await transition(s.id, 'paused', 6, 'pause');
    expect(paused.status).toBe('paused');

    const res = await correct(
      s.id,
      { position: 4, oldCue: 8, newCue: 3 },
      7,
      'correct-c4',
    );
    expect(res.statusCode).toBe(200);
    const corrected = res.json().performance as Performance;
    expect(corrected).toMatchObject({
      status: 'paused',
      version: 8,
      cues: [1, 2, 9, 3],
      deviation: { liveLength: 4, boundary: 1, recoverable: true, final: null },
    });
    expect(corrected.corrections).toEqual([
      { position: 4, oldCue: 8, newCue: 3, version: 8 },
    ]);

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.cues).toEqual([1, 2, 9, 3]);
    expect(loaded.corrections).toEqual([
      { position: 4, oldCue: 8, newCue: 3, version: 8 },
    ]);

    // Subsequent registration continues from the rebuilt state, not the old
    // sticky unrecoverable frontier.
    await transition(s.id, 'running', 8, 'resume');
    const after = await register(s.id, 4, 9, 'c5');
    expect(after.deviation?.recoverable).toBe(true);
    expect(after.deviation?.boundary).toBe(1);

    const ended = await transition(s.id, 'ended', 10, 'end');
    expect(ended.deviation?.final).toEqual({ status: 'ok', distance: 1 });
    expect(ended.corrections).toHaveLength(1);
  });

  it('accepts converging consecutive corrections using each current effective value', async () => {
    const s = await createSession({ command: 'create' }, '连续更正');
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 101, 2, 'c1');
    await register(s.id, 202, 3, 'c2');
    await transition(s.id, 'paused', 4, 'pause');

    let res = await correct(s.id, { position: 2, oldCue: 202, newCue: 203 }, 5, 'fix-1');
    expect(res.statusCode).toBe(200);
    expect(res.json().performance.cues).toEqual([101, 203]);
    expect(res.json().performance.version).toBe(6);

    res = await correct(s.id, { position: 2, oldCue: 203, newCue: 102 }, 6, 'fix-2');
    expect(res.statusCode).toBe(200);
    expect(res.json().performance.cues).toEqual([101, 102]);
    expect(res.json().performance.version).toBe(7);

    res = await correct(s.id, { position: 1, oldCue: 101, newCue: 111 }, 7, 'fix-3');
    expect(res.statusCode).toBe(200);
    const finalSnapshot = res.json().performance as Performance;
    expect(finalSnapshot.cues).toEqual([111, 102]);
    expect(finalSnapshot.corrections).toEqual([
      { position: 2, oldCue: 202, newCue: 203, version: 6 },
      { position: 2, oldCue: 203, newCue: 102, version: 7 },
      { position: 1, oldCue: 101, newCue: 111, version: 8 },
    ]);
  });

  it('serialises concurrent same-version corrections so only the first commits', async () => {
    const s = await createSession({ command: 'create' }, '并发更正');
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 101, 2, 'c1');
    await register(s.id, 202, 3, 'c2');
    await transition(s.id, 'paused', 4, 'pause');

    const payload = (requestId: string, newCue: number) => ({
      command: 'correctCue' as const,
      performanceId: s.id,
      position: 2,
      oldCue: 202,
      newCue,
      expectedVersion: 5,
      requestId,
    });
    const [a, b] = await Promise.all([
      sendCommand(payload('concurrent-correction-a', 303)),
      sendCommand(payload('concurrent-correction-b', 404)),
    ]);

    const committed = [a, b].filter((res) => res.statusCode === 200);
    const conflicts = [a, b].filter((res) => res.statusCode === 409);
    expect(committed).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expectRejected(conflicts[0]!.json(), 'VERSION_CONFLICT');

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.version).toBe(6);
    expect(loaded.cues).toEqual([101, committed[0]!.json().performance.cues[1]]);
    expect(loaded.corrections).toHaveLength(1);
  });

  it('supports corrections on legacy sessions but never fabricates deviation data', async () => {
    const s = await createSession({ command: 'create' }, '旧场次更正');
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 9, 2, 'bad');
    await transition(s.id, 'paused', 3, 'pause');

    const res = await correct(s.id, { position: 1, oldCue: 9, newCue: 10 }, 4, 'fix');
    expect(res.statusCode).toBe(200);
    const corrected = res.json().performance as Performance;
    expect(corrected.cues).toEqual([10]);
    expect(corrected.corrections).toEqual([{ position: 1, oldCue: 9, newCue: 10, version: 5 }]);
    expect(corrected.plan).toBeNull();
    expect(corrected.deviation).toBeNull();
  });

  it('uses the corrected timeline for the final ended verdict after resume and another pause', async () => {
    const s = await createSession(
      { command: 'create', planCues: [1, 2, 3], k: 1 },
      '终局更正',
    );
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await register(s.id, 9, 3, 'c2');
    await register(s.id, 2, 4, 'c3');
    await register(s.id, 3, 5, 'c4');
    await transition(s.id, 'paused', 6, 'pause');

    const corrected = await correct(s.id, { position: 2, oldCue: 9, newCue: 2 }, 7, 'fix');
    expect(corrected.statusCode).toBe(200);
    const ended = await transition(s.id, 'ended', 8, 'end');
    expect(ended.deviation?.final).toEqual({ status: 'ok', distance: 1 });
    expect(ended.cues).toEqual([1, 2, 2, 3]);
    expect(ended.corrections).toHaveLength(1);
  });
});

describe('correctCue — boundaries and rejected commands are atomic', () => {
  async function pausedPlanned(label: string): Promise<Performance> {
    const s = await createSession(
      { command: 'create', planCues: [1, 2, 3, 4], k: 1 },
      label,
    );
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await register(s.id, 9, 3, 'c2');
    await register(s.id, 8, 4, 'c3');
    const paused = await transition(s.id, 'paused', 5, 'pause');
    expect(paused.version).toBe(6);
    expect(paused.deviation?.recoverable).toBe(false);
    return paused;
  }

  it('rejects corrections while pending, running and ended with NOT_PAUSED', async () => {
    const pending = await createSession({ command: 'create' }, '待演更正');
    let res = await correct(pending.id, { position: 1, oldCue: 1, newCue: 2 }, 1, 'pending');
    expect(res.statusCode).toBe(409);
    expectRejected(res.json(), 'NOT_PAUSED');

    await transition(pending.id, 'running', 1, 'start');
    res = await correct(pending.id, { position: 1, oldCue: 1, newCue: 2 }, 2, 'running');
    expect(res.statusCode).toBe(409);
    expectRejected(res.json(), 'NOT_PAUSED');

    const s = await pausedPlanned('结束态更正');
    await transition(s.id, 'ended', 6, 'end');
    res = await correct(s.id, { position: 2, oldCue: 9, newCue: 2 }, 7, 'ended');
    expect(res.statusCode).toBe(409);
    expectRejected(res.json(), 'NOT_PAUSED');

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded).toMatchObject({ status: 'ended', version: 7, cues: [1, 9, 8], corrections: [] });
  });

  it('rejects positions outside the current timeline with INVALID_POSITION and leaves everything unchanged', async () => {
    const s = await pausedPlanned('无效位置');
    const zero = await correct(s.id, { position: 0, oldCue: 9, newCue: 2 }, 6, 'pos-zero');
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.code).toBe('INVALID_BODY');

    for (const position of [4, 99]) {
      const res = await correct(s.id, { position, oldCue: 8, newCue: 2 }, 6, `pos-${position}`);
      expect(res.statusCode).toBe(409);
      expectRejected(res.json(), 'INVALID_POSITION');
    }
    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded).toMatchObject({ version: 6, cues: [1, 9, 8], corrections: [] });
    expect(loaded.deviation?.liveLength).toBe(3);
  });

  it('rejects a mismatched expected old value and keeps the old monotone conclusion', async () => {
    const s = await pausedPlanned('旧值不符');
    const res = await correct(s.id, { position: 3, oldCue: 9, newCue: 3 }, 6, 'mismatch');
    expect(res.statusCode).toBe(409);
    expectRejected(res.json(), 'OLD_CUE_MISMATCH');

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.cues).toEqual([1, 9, 8]);
    expect(loaded.corrections).toEqual([]);
    expect(loaded.deviation?.recoverable).toBe(false);
    expect(loaded.version).toBe(6);
  });

  it('rejects stale expectedVersion before changing timeline, correction record or deviation', async () => {
    const s = await pausedPlanned('更正版本冲突');
    const res = await correct(s.id, { position: 2, oldCue: 9, newCue: 2 }, 5, 'stale');
    expect(res.statusCode).toBe(409);
    expectRejected(res.json(), 'VERSION_CONFLICT');

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded).toMatchObject({ version: 6, cues: [1, 9, 8], corrections: [] });
  });

  it('allows a request id rejected in paused correction to commit after preconditions change', async () => {
    const s = await pausedPlanned('更正拒绝复用');
    const requestId = 'rejected-correction-id';
    const badPosition = await sendCommand({
      command: 'correctCue',
      performanceId: s.id,
      position: 99,
      oldCue: 9,
      newCue: 2,
      expectedVersion: 6,
      requestId,
    });
    expect(badPosition.statusCode).toBe(409);
    expectRejected(badPosition.json(), 'INVALID_POSITION');

    const ok = await sendCommand({
      command: 'correctCue',
      performanceId: s.id,
      position: 3,
      oldCue: 8,
      newCue: 3,
      expectedVersion: 6,
      requestId,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().performance).toMatchObject({ version: 7, requestId, cues: [1, 9, 3] });

    const replay = await sendCommand({
      command: 'correctCue',
      performanceId: s.id,
      position: 2,
      oldCue: 2,
      newCue: 9,
      expectedVersion: 7,
      requestId,
    });
    expect(replay.statusCode).toBe(409);
    expectRejected(replay.json(), 'DUPLICATE_REQUEST');
    expect((await getPerformance(s.id)).json().performance.cues).toEqual([1, 9, 3]);
  });
});

describe('correctCue — envelope validation', () => {
  it('rejects malformed position and cue fields before adjudication', async () => {
    const s = await createSession({ command: 'create' }, '更正信封');
    await transition(s.id, 'running', 1, 'start');
    await register(s.id, 1, 2, 'c1');
    await transition(s.id, 'paused', 3, 'pause');

    const badPosition = await sendCommand({
      command: 'correctCue',
      performanceId: s.id,
      position: 0,
      oldCue: 1,
      newCue: 2,
      expectedVersion: 4,
      requestId: rid('bad-position'),
    });
    expect(badPosition.statusCode).toBe(400);
    expect(badPosition.json().error.code).toBe('INVALID_BODY');

    for (const [field, value] of [['oldCue', '1'], ['newCue', 1.5]] as const) {
      const res = await sendCommand({
        command: 'correctCue',
        performanceId: s.id,
        position: 1,
        oldCue: 1,
        newCue: 2,
        expectedVersion: 4,
        requestId: rid(`bad-${field}`),
        [field]: value,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CUE');
    }

    const loaded = (await getPerformance(s.id)).json().performance as Performance;
    expect(loaded.version).toBe(4);
    expect(loaded.corrections).toEqual([]);
  });
});
