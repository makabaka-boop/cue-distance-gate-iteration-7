import { describe, expect, it } from 'vitest';
import { ConsoleStore } from '../src/stores';
import { controlledConsoleDeps, FakeApiError, flush, perf } from './helpers';

/** Open a paused session with two registered cues at version 4. */
async function openPausedSession(
  store: ConsoleStore,
  commands: ReturnType<typeof controlledConsoleDeps>['commands'],
  cues: number[] = [101, 202],
) {
  store.setName('晚场');
  store.create();
  await flush();
  commands.shift()!.resolve(perf({ id: 'A', name: '晚场', status: 'pending', version: 1 }));
  await flush();
  store.transition('running');
  await flush();
  commands.shift()!.resolve(perf({ id: 'A', status: 'running', version: 2 }));
  await flush();
  for (const [i, cue] of cues.entries()) {
    store.setCueDraft(String(cue));
    store.registerCue();
    await flush();
    commands.shift()!.resolve(
      perf({ id: 'A', status: 'running', version: 3 + i, cues: cues.slice(0, i + 1) }),
    );
    await flush();
  }
  store.transition('paused');
  await flush();
  commands.shift()!.resolve(
    perf({ id: 'A', status: 'paused', version: 2 + cues.length + 1, cues }),
  );
  await flush();
}

describe('ConsoleStore — cue correction form', () => {
  it('opens only for a paused session row and submits position, expected old value and version', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPausedSession(store, commands);
    expect(store.getSnapshot().session?.status).toBe('paused');

    store.beginCorrection(1);
    expect(store.getSnapshot().correctingPosition).toBe(1);

    store.setCorrectionDraft('303');
    store.submitCorrection();
    await flush();

    expect(commands).toHaveLength(1);
    const payload = commands[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      command: 'correctCue',
      performanceId: 'A',
      position: 1,
      expectedOldValue: 202,
      cue: 303,
      expectedVersion: 5,
    });
    expect(typeof payload.requestId).toBe('string');

    commands.shift()!.resolve(
      perf({
        id: 'A',
        status: 'paused',
        version: 6,
        cues: [101, 303],
        corrections: [
          { position: 1, oldValue: 202, newValue: 303, version: 6, requestId: 'rq-1' },
        ],
      }),
    );
    await flush();

    const s = store.getSnapshot();
    expect(s.session?.cues).toEqual([101, 303]);
    expect(s.session?.corrections).toHaveLength(1);
    // Committed correction closes the form and consumes the draft.
    expect(s.correctingPosition).toBeNull();
    expect(s.correctionDraft).toBe('');
    expect(s.error).toBeNull();
  });

  it('ignores beginCorrection while running/pending/ended or for invalid rows', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('运行中');
    store.create();
    await flush();
    commands.shift()!.resolve(perf({ id: 'A', status: 'pending', version: 1 }));
    await flush();

    store.beginCorrection(0); // pending: no-op
    expect(store.getSnapshot().correctingPosition).toBeNull();

    store.transition('running');
    await flush();
    commands.shift()!.resolve(perf({ id: 'A', status: 'running', version: 2, cues: [1] }));
    await flush();
    store.beginCorrection(0); // running: no-op
    expect(store.getSnapshot().correctingPosition).toBeNull();

    store.transition('paused');
    await flush();
    commands.shift()!.resolve(perf({ id: 'A', status: 'paused', version: 3, cues: [1] }));
    await flush();
    store.beginCorrection(5); // out of range: no-op
    expect(store.getSnapshot().correctingPosition).toBeNull();
    store.beginCorrection(-1);
    expect(store.getSnapshot().correctingPosition).toBeNull();

    store.beginCorrection(0);
    expect(store.getSnapshot().correctingPosition).toBe(0);
    store.cancelCorrection();
    expect(store.getSnapshot().correctingPosition).toBeNull();
  });

  it('closes the open form when the session leaves the paused state', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPausedSession(store, commands);

    store.beginCorrection(1);
    store.setCorrectionDraft('303');
    expect(store.getSnapshot().correctingPosition).toBe(1);

    // Resuming the show ends the review: the form must not linger.
    store.transition('running');
    await flush();
    commands.shift()!.resolve(
      perf({ id: 'A', status: 'running', version: 6, cues: [101, 202] }),
    );
    await flush();
    const s = store.getSnapshot();
    expect(s.correctingPosition).toBeNull();
    expect(s.correctionDraft).toBe('');
  });

  it('keeps form, draft and snapshot on rejection so the correction can be retried', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPausedSession(store, commands);

    store.beginCorrection(0);
    store.setCorrectionDraft('999');
    store.submitCorrection();
    await flush();
    commands.shift()!.reject(new FakeApiError('COMMAND_REJECTED', 'OLD_VALUE_MISMATCH'));
    await flush();

    const s = store.getSnapshot();
    expect(s.error).toMatchObject({ code: 'COMMAND_REJECTED', reason: 'OLD_VALUE_MISMATCH' });
    expect(s.correctingPosition).toBe(0);
    expect(s.correctionDraft).toBe('999');
    expect(s.session?.cues).toEqual([101, 202]);
    expect(s.session?.version).toBe(5);
  });

  it('does not dispatch for an invalid replacement value and keeps the draft', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPausedSession(store, commands);

    store.beginCorrection(0);
    store.setCorrectionDraft('1.5');
    store.submitCorrection();
    await flush();

    expect(commands).toHaveLength(0);
    const s = store.getSnapshot();
    expect(s.error?.code).toBe('INVALID_CUE');
    expect(s.correctingPosition).toBe(0);
    expect(s.correctionDraft).toBe('1.5');
    expect(s.commandBusy).toBe(false);
  });
});

describe('ConsoleStore — correction answers never overwrite newer state', () => {
  it('a late correction response cannot roll back a newer same-session snapshot', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPausedSession(store, commands);

    // Correction submitted at v5; its answer is still in flight.
    store.beginCorrection(0);
    store.setCorrectionDraft('303');
    store.submitCorrection();
    await flush();
    const correctionCmd = commands.shift()!;

    // A reload of the same session lands first at v7 (another console
    // corrected further in the meantime).
    store.setLoadId('A');
    store.load();
    await flush();
    loads.shift()!.resolve(
      perf({
        id: 'A',
        status: 'paused',
        version: 7,
        cues: [303, 404],
        corrections: [
          { position: 0, oldValue: 101, newValue: 303, version: 6, requestId: 'rq-1' },
          { position: 1, oldValue: 202, newValue: 404, version: 7, requestId: 'rq-2' },
        ],
      }),
    );
    await flush();
    expect(store.getSnapshot().session?.version).toBe(7);

    // The own correction's v6 answer arrives late: the view must stay at v7.
    correctionCmd.resolve(
      perf({
        id: 'A',
        status: 'paused',
        version: 6,
        cues: [303, 202],
        corrections: [
          { position: 0, oldValue: 101, newValue: 303, version: 6, requestId: 'rq-1' },
        ],
      }),
    );
    await flush();
    const s = store.getSnapshot();
    expect(s.session?.version).toBe(7);
    expect(s.session?.cues).toEqual([303, 404]);
    expect(s.session?.corrections).toHaveLength(2);
  });

  it('a correction answer for session A never replaces session B on screen', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPausedSession(store, commands);

    store.beginCorrection(0);
    store.setCorrectionDraft('303');
    store.submitCorrection();
    await flush();
    const correctionCmd = commands.shift()!;

    // Stage manager switches to session B before A's answer arrives.
    store.setLoadId('B');
    store.load();
    await flush();
    loads.shift()!.resolve(perf({ id: 'B', name: 'B 场', status: 'running', version: 2 }));
    await flush();
    expect(store.getSnapshot().session?.id).toBe('B');
    // Switching sessions closed the correction form.
    expect(store.getSnapshot().correctingPosition).toBeNull();

    correctionCmd.resolve(
      perf({
        id: 'A',
        status: 'paused',
        version: 6,
        cues: [303, 202],
        corrections: [
          { position: 0, oldValue: 101, newValue: 303, version: 6, requestId: 'rq-1' },
        ],
      }),
    );
    await flush();
    const s = store.getSnapshot();
    expect(s.session?.id).toBe('B');
    expect(s.session?.version).toBe(2);
    expect(s.error).toBeNull();
  });

  it('a stale correction rejection surfaces no error against the newer session', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPausedSession(store, commands);

    store.beginCorrection(0);
    store.setCorrectionDraft('303');
    store.submitCorrection();
    await flush();
    const correctionCmd = commands.shift()!;

    store.setLoadId('B');
    store.load();
    await flush();
    loads.shift()!.resolve(perf({ id: 'B', status: 'pending', version: 1 }));
    await flush();

    correctionCmd.reject(new FakeApiError('COMMAND_REJECTED', 'VERSION_CONFLICT'));
    await flush();
    const s = store.getSnapshot();
    expect(s.error).toBeNull();
    expect(s.session?.id).toBe('B');
  });
});
