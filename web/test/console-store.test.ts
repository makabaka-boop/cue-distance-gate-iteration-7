import { describe, expect, it } from 'vitest';
import { ConsoleStore, DeviationStore } from '../src/stores';
import {
  controlledConsoleDeps,
  controlledDeviationDeps,
  distance,
  FakeApiError,
  flush,
  perf,
} from './helpers';

function openRunningSession(
  store: ConsoleStore,
  commands: ReturnType<typeof controlledConsoleDeps>['commands'],
  cueDraft?: string,
) {
  store.setName('晚场');
  store.create();
  const create = commands.shift()!;
  const created = perf({
    id: 'A',
    name: '晚场',
    status: 'pending',
    version: 1,
    requestId: 'rid-create',
  });
  create.resolve(created);
  return flush().then(() => {
    store.transition('running');
    const start = commands.shift()!;
    start.resolve(perf({ id: 'A', status: 'running', version: 2, requestId: 'rid-start' }));
    if (cueDraft !== undefined) store.setCueDraft(cueDraft);
    return flush();
  });
}

describe('ConsoleStore — cue draft lifecycle', () => {
  it('keeps the draft while the command is in flight (switch away and back)', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openRunningSession(store, commands, '101');

    store.registerCue();
    await flush();
    expect(store.getSnapshot().commandBusy).toBe(true);
    // Sent but not answered: the input the stage manager typed is still here.
    expect(store.getSnapshot().cueDraft).toBe('101');
    expect(store.getSnapshot().session?.version).toBe(2);

    // Response arrives after the round-trip (same store instance = preserved).
    commands[0].resolve(
      perf({ id: 'A', status: 'running', version: 3, requestId: 'rid-cue', cues: [101] }),
    );
    await flush();
    const s = store.getSnapshot();
    expect(s.commandBusy).toBe(false);
    expect(s.session?.id).toBe('A');
    expect(s.session?.version).toBe(3);
    // Exactly one cue, committed once; draft consumed.
    expect(s.session?.cues).toEqual([101]);
    expect(s.cueDraft).toBe('');
    expect(s.error).toBeNull();
  });

  it('keeps the draft and snapshot on failure (VERSION_CONFLICT) so cue can retry', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openRunningSession(store, commands, '202');

    store.registerCue();
    await flush();
    // Switch happens while in flight; answer is a rejection after return.
    commands[0].reject(new FakeApiError('COMMAND_REJECTED', 'VERSION_CONFLICT'));
    await flush();

    const s = store.getSnapshot();
    expect(s.commandBusy).toBe(false);
    expect(s.error).toMatchObject({ code: 'COMMAND_REJECTED', reason: 'VERSION_CONFLICT' });
    expect(s.cueDraft).toBe('202');
    expect(s.session?.version).toBe(2);
    expect(s.session?.cues).toEqual([]);

    // Retry with corrected version commits once; draft clears on success.
    expect(commands).toHaveLength(1); // the rejected attempt still queued here
    commands.shift();
    store.registerCue();
    await flush();
    expect(commands).toHaveLength(1); // the retry is a fresh submission
    commands.shift()!.resolve(
      perf({ id: 'A', version: 3, requestId: 'rid-retry', cues: [202] }),
    );
    await flush();
    const after = store.getSnapshot();
    expect(after.session?.cues).toEqual([202]);
    expect(after.session?.version).toBe(3);
    expect(after.cueDraft).toBe('');
    expect(after.error).toBeNull();
  });

  it('does not fire a request for invalid client input and keeps the draft', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openRunningSession(store, commands, '1.5');

    store.registerCue();
    // Session running at v2, but no command is dispatched for an invalid cue.
    const after = store.getSnapshot();
    expect(commands).toHaveLength(0);
    expect(after.error?.code).toBe('INVALID_CUE');
    expect(after.cueDraft).toBe('1.5');
    expect(after.commandBusy).toBe(false);
    expect(after.session?.version).toBe(2);
  });
});

describe('ConsoleStore — in-flight answers target only their own session', () => {
  it('load of session B supersedes command A; late A answer never replaces B', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openRunningSession(store, commands, '101');

    // 1) cue command for A submitted, answer not back.
    store.registerCue();
    await flush();
    expect(commands).toHaveLength(1);
    const cmdA = commands.shift()!;

    // 2) stage manager loads session B (latest user action).
    store.setLoadId('B-id');
    store.load();
    await flush();
    expect(loads).toHaveLength(1);

    // B answer arrives first: display switches to B.
    loads[0].resolve(perf({ id: 'B', name: 'B 场', status: 'pending', version: 1 }));
    await flush();
    expect(store.getSnapshot().session?.id).toBe('B');
    // The draft in the box is untouched by B's load.
    expect(store.getSnapshot().cueDraft).toBe('101');

    // Late A answer must NOT replace B, even though A committed.
    cmdA.resolve(
      perf({ id: 'A', status: 'running', version: 3, requestId: 'rid-A', cues: [101] }),
    );
    await flush();
    const s = store.getSnapshot();
    expect(s.session?.id).toBe('B');
    expect(s.session?.version).toBe(1);
    // A's draft is not consumed by an answer while B is on screen.
    expect(s.cueDraft).toBe('101');
    expect(s.commandBusy).toBe(false);
    expect(s.error).toBeNull();
  });

  it('a stale GET for the same session may catch it up but never downgrade', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openRunningSession(store, commands);

    // Load A (refresh) is in flight, then a command commits v3 first.
    store.setLoadId('A');
    store.load();
    await flush();
    const loadCall = loads.shift()!;

    store.transition('paused');
    await flush();
    commands.shift()!.resolve(
      perf({ id: 'A', status: 'paused', version: 3, requestId: 'rid-pause' }),
    );
    await flush();
    expect(store.getSnapshot().session?.version).toBe(3);

    // Stale GET snapshot at v2 must not roll v3 backwards.
    loadCall.resolve(perf({ id: 'A', status: 'running', version: 2 }));
    await flush();
    expect(store.getSnapshot().session?.version).toBe(3);
    expect(store.getSnapshot().session?.status).toBe('paused');

    // A newer stale GET (v4) for the same session still catches it up.
    store.transition('running');
    await flush();
    const cmd2 = commands.shift()!;
    store.setLoadId('A');
    store.load();
    await flush();
    const load2 = loads.shift()!;
    cmd2.resolve(perf({ id: 'A', status: 'running', version: 4, requestId: 'r4' }));
    await flush();
    load2.resolve(perf({ id: 'A', status: 'running', version: 5, requestId: 'r5' }));
    await flush();
    expect(store.getSnapshot().session?.version).toBe(5);
  });

  it('a stale rejected command surfaces no error against the newer session', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openRunningSession(store, commands, '101');

    store.registerCue(); // against A, v2
    await flush();
    const cmdA = commands.shift()!;

    store.setLoadId('B');
    store.load();
    await flush();
    loads.shift()!.resolve(perf({ id: 'B', version: 1, status: 'pending' }));
    await flush();
    expect(store.getSnapshot().session?.id).toBe('B');

    cmdA.reject(new FakeApiError('COMMAND_REJECTED', 'VERSION_CONFLICT'));
    await flush();
    // Foreign-session failure must not leak an error into the B view.
    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().session?.id).toBe('B');
  });

  it('a failed load keeps the session already on screen and reports the error', async () => {
    const { deps, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setLoadId('missing');
    store.load();
    await flush();
    loads[0].reject(new FakeApiError('SESSION_NOT_FOUND', undefined, 404));
    await flush();
    const s = store.getSnapshot();
    expect(s.loadBusy).toBe(false);
    expect(s.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('cue draft clears when the owning session commits even after a newer same-session load', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openRunningSession(store, commands, '303');

    store.registerCue();
    await flush();
    const cmd = commands.shift()!;

    store.setLoadId('A');
    store.load();
    await flush();
    const load = loads.shift()!;
    // Load catches the same session up to v3 first.
    load.resolve(perf({ id: 'A', version: 3, status: 'running', requestId: 'rid-load' }));
    await flush();
    expect(store.getSnapshot().session?.id).toBe('A');
    // Command then resolves v4: same owning session -> draft consumed.
    cmd.resolve(
      perf({ id: 'A', version: 4, status: 'running', requestId: 'rid-cue', cues: [303] }),
    );
    await flush();
    expect(store.getSnapshot().cueDraft).toBe('');
    expect(store.getSnapshot().session?.cues).toEqual([303]);
  });
});

describe('ConsoleStore — busy state survives the whole round-trip', () => {
  it('stays busy from request through tab switch until the response lands', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openRunningSession(store, commands);

    store.transition('paused');
    await flush();
    expect(store.getSnapshot().commandBusy).toBe(true);
    // (switch to deviation and back — store untouched — still busy)
    expect(store.getSnapshot().commandBusy).toBe(true);
    commands[0].resolve(perf({ id: 'A', status: 'paused', version: 3 }));
    await flush();
    expect(store.getSnapshot().commandBusy).toBe(false);
  });
});

describe('entry isolation', () => {
  it('a console command failure never touches the deviation entry', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const console = new ConsoleStore(deps);
    const dev = controlledDeviationDeps();
    const deviation = new DeviationStore(dev.deps);
    deviation.setPlanText('[1]');
    deviation.setLiveText('[1]');
    deviation.setKText('0');
    deviation.compare();
    await flush();
    dev.calls[0].resolve(distance(0, 0, 1, 1));
    await flush();
    const verdictBefore = deviation.getSnapshot().outcome;
    expect(verdictBefore?.kind).toBe('result');

    await openRunningSession(console, commands, '1');
    console.registerCue();
    await flush();
    commands[0].reject(new FakeApiError('COMMAND_REJECTED', 'NOT_RUNNING'));
    await flush();
    expect(console.getSnapshot().error?.reason).toBe('NOT_RUNNING');

    // Deviation inputs and verdict are exactly as before.
    expect(deviation.getSnapshot().outcome).toEqual(verdictBefore);
    expect(deviation.getSnapshot().planText).toBe('[1]');
    expect(deviation.getSnapshot().busy).toBe(false);
  });

  it('two console instances never share session, draft or busy state', async () => {
    const one = controlledConsoleDeps();
    const two = controlledConsoleDeps();
    const a = new ConsoleStore(one.deps);
    const b = new ConsoleStore(two.deps);

    a.setName('A 场');
    a.create();
    await flush();
    one.commands[0].resolve(perf({ id: 'A', name: 'A 场', version: 1, status: 'pending' }));
    await flush();

    expect(a.getSnapshot().session?.id).toBe('A');
    expect(b.getSnapshot().session).toBeNull();
    expect(b.getSnapshot().nameDraft).toBe('');
    expect(b.getSnapshot().commandBusy).toBe(false);
  });
});
