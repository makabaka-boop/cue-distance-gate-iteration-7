import { describe, expect, it } from 'vitest';
import { ConsoleStore } from '../src/stores';
import { controlledConsoleDeps, flush, perf } from './helpers';
import type { Performance } from '../src/api';

function planned(
  over: Partial<Performance> & { id: string },
  plan = { cues: [1, 2, 3], k: 1 },
  deviation?: Performance['deviation'],
): Performance {
  return perf({
    ...over,
    plan,
    deviation:
      deviation ??
      ({
        k: plan.k,
        plannedLength: plan.cues.length,
        liveLength: over.cues?.length ?? 0,
        boundary: 0,
        recoverable: true,
        final: null,
      } satisfies NonNullable<Performance['deviation']>),
  });
}

describe('ConsoleStore — optional fixed plan at creation', () => {
  it('sends a legacy create (no planCues/k) when the plan toggle is off', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('旧场次');
    store.create();
    await flush();
    expect(commands).toHaveLength(1);
    expect(commands[0]!.payload).toMatchObject({
      command: 'create',
      name: '旧场次',
    });
    expect((commands[0]!.payload as Record<string, unknown>).planCues).toBeUndefined();
    expect((commands[0]!.payload as Record<string, unknown>).k).toBeUndefined();
  });

  it('sends planCues and k together when the toggle is on and inputs are valid', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('带计划场次');
    store.setPlanEnabled(true);
    store.setPlanCuesDraft('[1, 2, 3]');
    store.setPlanKDraft('2');
    store.create();
    await flush();
    expect(commands).toHaveLength(1);
    expect(commands[0]!.payload).toMatchObject({
      command: 'create',
      name: '带计划场次',
      planCues: [1, 2, 3],
      k: 2,
    });
    expect(commands[0]!.payload).toHaveProperty('requestId');
  });

  it('accepts an empty plan array', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('空计划');
    store.setPlanEnabled(true);
    store.setPlanCuesDraft('[]');
    store.setPlanKDraft('0');
    store.create();
    await flush();
    expect((commands[0]!.payload as { planCues?: number[] }).planCues).toEqual([]);
  });

  it('does not dispatch on invalid plan draft and reports the error, keeping drafts', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('坏计划');
    store.setPlanEnabled(true);

    store.setPlanCuesDraft('[1, 2,');
    store.setPlanKDraft('2');
    store.create();
    expect(commands).toHaveLength(0);
    expect(store.getSnapshot().error?.code).toBe('INVALID_JSON');

    store.setPlanCuesDraft('[1, "x"]');
    store.create();
    expect(store.getSnapshot().error?.code).toBe('INVALID_ELEMENT');

    store.setPlanCuesDraft('[1]');
    store.setPlanKDraft('501');
    store.create();
    expect(store.getSnapshot().error?.code).toBe('INVALID_K');

    // Drafts survive the failed validations for correction.
    expect(store.getSnapshot().planCuesDraft).toBe('[1]');
    expect(store.getSnapshot().planKDraft).toBe('501');
  });

  it('plan drafts stay editable after a session exists and only feed the NEXT create', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('第一场');
    store.setPlanEnabled(true);
    store.setPlanCuesDraft('[1, 2]');
    store.setPlanKDraft('1');
    store.create();
    await flush();
    commands
      .shift()!
      .resolve(
        planned(
          { id: 'A', name: '第一场', status: 'pending', version: 1, requestId: 'r1' },
          { cues: [1, 2], k: 1 },
        ),
      );
    await flush();

    // The created session keeps its own sealed plan; editing the textarea
    // afterwards cannot change it.
    store.setPlanCuesDraft('[9, 9, 9, 9]');
    store.setPlanKDraft('4');
    const shown = store.getSnapshot().session!;
    expect(shown.plan).toEqual({ cues: [1, 2], k: 1 });

    // A second create picks up the new draft.
    store.setName('第二场');
    store.create();
    await flush();
    const payload = commands[0]!.payload as { planCues: number[]; k: number; name: string };
    expect(payload).toMatchObject({ name: '第二场', planCues: [9, 9, 9, 9], k: 4 });
  });
});

describe('ConsoleStore — per-cue deviation state rides the session version', () => {
  async function openPlannedRunning(
    store: ConsoleStore,
    commands: ReturnType<typeof controlledConsoleDeps>['commands'],
  ) {
    store.setName('晚场');
    store.setPlanEnabled(true);
    store.setPlanCuesDraft('[1, 2, 3]');
    store.setPlanKDraft('1');
    store.create();
    await flush();
    commands
      .shift()!
      .resolve(
        planned({ id: 'A', name: '晚场', status: 'pending', version: 1, requestId: 'r1' }),
      );
    await flush();
    store.transition('running');
    await flush();
    commands
      .shift()!
      .resolve(planned({ id: 'A', status: 'running', version: 2, requestId: 'r2' }));
    await flush();
  }

  it('each committed cue replaces the deviation state with the snapshot carried by that version', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPlannedRunning(store, commands);
    store.setCueDraft('1');
    store.registerCue();
    await flush();
    commands.shift()!.resolve(
      planned(
        { id: 'A', status: 'running', version: 3, requestId: 'r3', cues: [1] },
        { cues: [1, 2, 3], k: 1 },
        {
          k: 1,
          plannedLength: 3,
          liveLength: 1,
          boundary: 0,
          recoverable: true,
          final: null,
        },
      ),
    );
    await flush();
    let s = store.getSnapshot();
    expect(s.session?.deviation).toMatchObject({
      liveLength: 1,
      boundary: 0,
      recoverable: true,
      final: null,
    });
    expect(s.cueDraft).toBe('');

    // Next cue drives it unrecoverable: the v4 snapshot says so.
    store.setCueDraft('9');
    store.registerCue();
    await flush();
    commands.shift()!.resolve(
      planned(
        { id: 'A', status: 'running', version: 4, requestId: 'r4', cues: [1, 9] },
        { cues: [1, 2, 3], k: 1 },
        {
          k: 1,
          plannedLength: 3,
          liveLength: 2,
          boundary: 2,
          recoverable: false,
          final: null,
        },
      ),
    );
    await flush();
    s = store.getSnapshot();
    expect(s.session?.version).toBe(4);
    expect(s.session?.deviation?.recoverable).toBe(false);
    expect(s.session?.deviation?.boundary).toBe(2);
  });

  it('a rejected cue keeps the prior deviation state (no advance)', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPlannedRunning(store, commands);
    store.setCueDraft('1');
    store.registerCue();
    await flush();
    commands.shift()!.resolve(
      planned(
        { id: 'A', status: 'running', version: 3, requestId: 'r3', cues: [1] },
        { cues: [1, 2, 3], k: 1 },
        { k: 1, plannedLength: 3, liveLength: 1, boundary: 0, recoverable: true, final: null },
      ),
    );
    await flush();

    store.setCueDraft('2');
    store.registerCue();
    await flush();
    class Err extends Error {
      code = 'COMMAND_REJECTED';
      reason = 'VERSION_CONFLICT';
    }
    commands.shift()!.reject(new Err());
    await flush();

    const s = store.getSnapshot();
    expect(s.error?.reason).toBe('VERSION_CONFLICT');
    expect(s.session?.version).toBe(3);
    expect(s.session?.deviation).toMatchObject({ liveLength: 1, boundary: 0 });
    expect(s.cueDraft).toBe('2');
  });

  it('ending carries the whole-plan final verdict on the ended snapshot', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPlannedRunning(store, commands);
    store.transition('ended');
    await flush();
    commands.shift()!.resolve(
      planned(
        { id: 'A', status: 'ended', version: 3, requestId: 'rend', cues: [] },
        { cues: [1, 2, 3], k: 1 },
        {
          k: 1,
          plannedLength: 3,
          liveLength: 0,
          boundary: 0,
          recoverable: true,
          final: { status: 'exceeded' },
        },
      ),
    );
    await flush();
    const s = store.getSnapshot();
    expect(s.session?.status).toBe('ended');
    expect(s.session?.deviation?.final).toEqual({ status: 'exceeded' });
  });
});

describe('ConsoleStore — deviation hints never mix across sessions / late responses', () => {
  it('loading session B replaces plan and deviation together; a late A answer cannot mix them', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);

    // Session A: unrecoverable at v4.
    store.setName('A');
    store.create();
    await flush();
    commands
      .shift()!
      .resolve(perf({ id: 'A', name: 'A', status: 'pending', version: 1 }));
    await flush();
    store.transition('running');
    await flush();
    commands
      .shift()!
      .resolve(perf({ id: 'A', status: 'running', version: 2 }));
    await flush();
    store.setCueDraft('5');
    store.registerCue();
    await flush();
    const cmdA = commands.shift()!;

    // Load B (a planned, healthy session) while A's cue is in flight.
    store.setLoadId('B');
    store.load();
    await flush();
    loads
      .shift()!
      .resolve(
        planned(
          { id: 'B', name: 'B', status: 'running', version: 2, cues: [9], requestId: 'rb' },
          { cues: [9, 8], k: 5 },
          { k: 5, plannedLength: 2, liveLength: 1, boundary: 0, recoverable: true, final: null },
        ),
      );
    await flush();

    let s = store.getSnapshot();
    expect(s.session?.id).toBe('B');
    expect(s.session?.plan).toEqual({ cues: [9, 8], k: 5 });
    expect(s.session?.deviation?.recoverable).toBe(true);

    // Late A answer must not replace B nor leak A's deviation into B.
    cmdA.resolve(
      planned(
        { id: 'A', status: 'running', version: 3, cues: [5], requestId: 'ra' },
        { cues: [1], k: 0 },
        { k: 0, plannedLength: 1, liveLength: 1, boundary: 1, recoverable: false, final: null },
      ),
    );
    await flush();
    s = store.getSnapshot();
    expect(s.session?.id).toBe('B');
    expect(s.session?.plan).toEqual({ cues: [9, 8], k: 5 });
    expect(s.session?.deviation).toMatchObject({
      k: 5,
      liveLength: 1,
      recoverable: true,
    });
    // A's failure-ish result surfaces no error against B either.
    expect(s.error).toBeNull();
  });

  it('a stale same-session snapshot with an older deviation cannot roll the view back', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);

    // A at v4 unrecoverable via commands.
    store.setName('A');
    store.create();
    await flush();
    commands.shift()!.resolve(perf({ id: 'A', version: 1, status: 'pending' }));
    await flush();
    store.transition('running');
    await flush();
    commands
      .shift()!
      .resolve(
        planned(
          { id: 'A', version: 2, status: 'running' },
          { cues: [1], k: 0 },
          { k: 0, plannedLength: 1, liveLength: 0, boundary: 0, recoverable: true, final: null },
        ),
      );
    await flush();
    store.setCueDraft('5');
    store.registerCue();
    await flush();
    commands
      .shift()!
      .resolve(
        planned(
          { id: 'A', version: 3, status: 'running', cues: [5] },
          { cues: [1], k: 0 },
          { k: 0, plannedLength: 1, liveLength: 1, boundary: 1, recoverable: false, final: null },
        ),
      );
    await flush();
    expect(store.getSnapshot().session?.deviation?.recoverable).toBe(false);

    // A stale GET for the SAME session at the older v2 must not downgrade
    // the deviation hint to "recoverable".
    store.setLoadId('A');
    store.load();
    await flush();
    loads
      .shift()!
      .resolve(
        planned(
          { id: 'A', version: 2, status: 'running' },
          { cues: [1], k: 0 },
          { k: 0, plannedLength: 1, liveLength: 0, boundary: 0, recoverable: true, final: null },
        ),
      );
    await flush();
    const s = store.getSnapshot();
    expect(s.session?.version).toBe(3);
    expect(s.session?.deviation?.recoverable).toBe(false);
  });
});
