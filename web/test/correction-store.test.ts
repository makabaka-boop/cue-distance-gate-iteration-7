import { describe, expect, it } from 'vitest';
import { ConsoleStore } from '../src/stores';
import { controlledConsoleDeps, flush, perf } from './helpers';

function paused(over: Parameters<typeof perf>[0]) {
  return perf({
    name: '晚场',
    status: 'paused',
    cues: [],
    corrections: [],
    plan: null,
    deviation: null,
    ...over,
  });
}

describe('ConsoleStore — cue corrections', () => {
  it('submits a correction only from the paused snapshot and clears drafts on the new snapshot', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);

    store.setName('晚场');
    store.create();
    await flush();
    commands
      .shift()!
      .resolve(paused({ id: 'A', status: 'pending', version: 1, requestId: 'create' }));
    await flush();

    store.transition('running');
    await flush();
    commands
      .shift()!
      .resolve(paused({ id: 'A', status: 'running', version: 2, requestId: 'start' }));
    await flush();
    store.setCueDraft('9');
    store.registerCue();
    await flush();
    commands
      .shift()!
      .resolve(
        paused({ id: 'A', status: 'running', version: 3, requestId: 'cue', cues: [9] }),
      );
    await flush();

    store.transition('paused');
    await flush();
    commands
      .shift()!
      .resolve(
        paused({ id: 'A', status: 'paused', version: 4, requestId: 'pause', cues: [9] }),
      );
    await flush();

    store.setCorrectionPositionDraft('1');
    store.setCorrectionOldDraft('9');
    store.setCorrectionNewDraft('10');
    store.correctCue();
    await flush();

    expect(commands).toHaveLength(1);
    expect(commands[0]!.payload).toMatchObject({
      command: 'correctCue',
      performanceId: 'A',
      position: 1,
      oldCue: 9,
      newCue: 10,
      expectedVersion: 4,
    });

    commands.shift()!.resolve(
      paused({
        id: 'A',
        status: 'paused',
        version: 5,
        requestId: 'correction',
        cues: [10],
        corrections: [{ position: 1, oldCue: 9, newCue: 10, version: 5 }],
      }),
    );
    await flush();

    const s = store.getSnapshot();
    expect(s.session?.cues).toEqual([10]);
    expect(s.session?.corrections).toEqual([
      { position: 1, oldCue: 9, newCue: 10, version: 5 },
    ]);
    expect(s.correctionPositionDraft).toBe('');
    expect(s.correctionOldDraft).toBe('');
    expect(s.correctionNewDraft).toBe('');
    expect(s.error).toBeNull();
  });

  it('keeps correction drafts and reports the reason when the server rejects', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('晚场');
    store.create();
    await flush();
    commands.shift()!.resolve(paused({ id: 'A', version: 1 }));
    await flush();

    store.setCorrectionPositionDraft('1');
    store.setCorrectionOldDraft('1');
    store.setCorrectionNewDraft('2');
    store.correctCue();
    await flush();
    class Err extends Error {
      code = 'COMMAND_REJECTED';
      reason = 'OLD_CUE_MISMATCH';
    }
    commands.shift()!.reject(new Err());
    await flush();

    const s = store.getSnapshot();
    expect(s.error).toMatchObject({ code: 'COMMAND_REJECTED', reason: 'OLD_CUE_MISMATCH' });
    expect(s.correctionPositionDraft).toBe('1');
    expect(s.correctionOldDraft).toBe('1');
    expect(s.correctionNewDraft).toBe('2');
    expect(s.session?.version).toBe(1);
  });

  it('does not dispatch for a non-positive position and keeps the draft', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('晚场');
    store.create();
    await flush();
    commands.shift()!.resolve(paused({ id: 'A', status: 'paused', version: 1 }));
    await flush();

    store.setCorrectionPositionDraft('0');
    store.setCorrectionOldDraft('1');
    store.setCorrectionNewDraft('2');
    store.correctCue();

    expect(commands).toHaveLength(0);
    const s = store.getSnapshot();
    expect(s.error?.code).toBe('INVALID_POSITION');
    expect(s.correctionPositionDraft).toBe('0');
  });

  it('allows consecutive corrections by sending each current version and effective old cue', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('晚场');
    store.create();
    await flush();
    commands
      .shift()!
      .resolve(paused({ id: 'A', status: 'paused', version: 3, cues: [1, 2] }));
    await flush();

    store.setCorrectionPositionDraft('2');
    store.setCorrectionOldDraft('2');
    store.setCorrectionNewDraft('3');
    store.correctCue();
    await flush();
    expect(commands[0]!.payload).toMatchObject({ expectedVersion: 3, oldCue: 2, newCue: 3 });
    commands.shift()!.resolve(
      paused({
        id: 'A',
        version: 4,
        cues: [1, 3],
        corrections: [{ position: 2, oldCue: 2, newCue: 3, version: 4 }],
      }),
    );
    await flush();

    store.setCorrectionPositionDraft('2');
    store.setCorrectionOldDraft('3');
    store.setCorrectionNewDraft('4');
    store.correctCue();
    await flush();
    expect(commands[0]!.payload).toMatchObject({ expectedVersion: 4, oldCue: 3, newCue: 4 });
  });

  it('a late older correction response cannot overwrite a newer version', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('晚场');
    store.create();
    await flush();
    commands
      .shift()!
      .resolve(paused({ id: 'A', status: 'paused', version: 4, cues: [1, 9] }));
    await flush();

    store.setCorrectionPositionDraft('2');
    store.setCorrectionOldDraft('9');
    store.setCorrectionNewDraft('2');
    store.correctCue();
    await flush();
    const correction = commands.shift()!;

    // A refresh/newer command first presents version 7.
    store.setLoadId('A');
    store.load();
    await flush();
    loads
      .shift()!
      .resolve(
        paused({
          id: 'A',
          version: 7,
          cues: [1, 2, 3],
          corrections: [{ position: 2, oldCue: 9, newCue: 2, version: 5 }],
        }),
      );
    await flush();

    correction.resolve(
      paused({
        id: 'A',
        version: 5,
        cues: [1, 2],
        corrections: [{ position: 2, oldCue: 9, newCue: 2, version: 5 }],
      }),
    );
    await flush();

    const s = store.getSnapshot();
    expect(s.session?.version).toBe(7);
    expect(s.session?.cues).toEqual([1, 2, 3]);
  });
});
