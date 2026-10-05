import { describe, expect, it } from 'vitest';
import { DeviationStore } from '../src/stores';
import { controlledDeviationDeps, distance, FakeApiError, flush } from './helpers';

function setup() {
  const { deps, calls } = controlledDeviationDeps();
  const store = new DeviationStore(deps);
  return { store, calls };
}

describe('DeviationStore — inputs and identity across the round-trip', () => {
  it('keeps inputs and shows the in-flight request identity while pending', async () => {
    const { store, calls } = setup();
    store.setPlanText('[1, 2, 3]');
    store.setLiveText('[1, 3]');
    store.setKText('1');
    store.compare();
    await flush();

    expect(calls).toHaveLength(1);
    const s = store.getSnapshot();
    expect(s.busy).toBe(true);
    expect(s.planText).toBe('[1, 2, 3]');
    expect(s.pending).toMatchObject({ seq: 1, k: 1, lengths: { a: 3, b: 2 } });
    expect(typeof s.pending?.fingerprint).toBe('string');
    expect(s.pending?.fingerprint).toHaveLength(8);
    expect(s.outcome).toBeNull();

    // Answer after switching away and back.
    calls[0].resolve(distance(1, 1, 3, 2));
    await flush();
    const after = store.getSnapshot();
    expect(after.busy).toBe(false);
    expect(after.pending).toBeNull();
    expect(after.outcome?.kind).toBe('result');
    if (after.outcome?.kind === 'result') {
      expect(after.outcome.value).toEqual(distance(1, 1, 3, 2));
      expect(after.outcome.identity.seq).toBe(1);
    }
    expect(after.planText).toBe('[1, 2, 3]');
  });

  it('does not send and keeps inputs for client-side parse errors', () => {
    const { store, calls } = setup();
    store.setPlanText('not-json');
    store.setLiveText('[1]');
    store.setKText('0');
    store.compare();
    expect(calls).toHaveLength(0);
    const o = store.getSnapshot().outcome;
    expect(o?.kind).toBe('error');
    if (o?.kind === 'error') {
      expect(o.code).toBe('INVALID_JSON');
      expect(o.identity).toBeNull();
    }
    expect(store.getSnapshot().planText).toBe('not-json');
    expect(store.getSnapshot().busy).toBe(false);
  });

  it('rejects K out of range with INVALID_K without sending', () => {
    const { store, calls } = setup();
    store.setPlanText('[]');
    store.setLiveText('[]');
    store.setKText('501');
    store.compare();
    expect(calls).toHaveLength(0);
    expect(store.getSnapshot().outcome).toMatchObject({ kind: 'error' });
    expect((store.getSnapshot().outcome as { code?: string }).code).toBe('INVALID_K');
  });
});

describe('DeviationStore — overtaken requests', () => {
  it('a late response of request #1 never overwrites conclusion #2', async () => {
    const { store, calls } = setup();

    // Request 1: [1] vs [2], k=2 -> distance 2.
    store.setPlanText('[1]');
    store.setLiveText('[2]');
    store.setKText('2');
    store.compare();
    await flush();
    const first = calls.shift()!;

    // User edits and submits request 2 before #1 answers.
    store.setPlanText('[1, 2]');
    store.setLiveText('[1, 2]');
    store.setKText('0');
    store.compare();
    await flush();
    const second = calls.shift()!;
    expect(store.getSnapshot().pending?.seq).toBe(2);

    // #2 resolves first: that is the visible verdict.
    second.resolve(distance(0, 0, 2, 2));
    await flush();
    expect(store.getSnapshot().busy).toBe(true); // #1 still outstanding
    let outcome = store.getSnapshot().outcome;
    expect(outcome?.kind).toBe('result');
    if (outcome?.kind === 'result') expect(outcome.identity.seq).toBe(2);

    // #1 resolves afterwards: discarded entirely — conclusion stays #2 and
    // busy only clears once both requests are home.
    first.resolve(distance(2, 2, 1, 1));
    await flush();
    const s = store.getSnapshot();
    expect(s.busy).toBe(false);
    expect(s.pending).toBeNull();
    expect(s.outcome?.kind).toBe('result');
    if (s.outcome?.kind === 'result') {
      expect(s.outcome.identity.seq).toBe(2);
      expect(s.outcome.value).toEqual(distance(0, 0, 2, 2));
    }
  });

  it('identities differ for different inputs so consecutive verdicts are distinguishable', async () => {
    const { store, calls } = setup();
    store.setPlanText('[1, 2]');
    store.setLiveText('[1, 2]');
    store.setKText('0');
    store.compare();
    await flush();
    const fp1 = store.getSnapshot().pending!.fingerprint;
    calls.shift()!.resolve(distance(0, 0, 2, 2));
    await flush();

    store.setLiveText('[1, 3]');
    store.setKText('1');
    store.compare();
    await flush();
    const p2 = store.getSnapshot().pending!;
    expect(p2.seq).toBe(2);
    expect(p2.fingerprint).not.toBe(fp1);
    calls.shift()!.resolve(distance(1, 1, 2, 2));
    await flush();

    const o = store.getSnapshot().outcome;
    if (o?.kind === 'result') {
      expect(o.identity.seq).toBe(2);
      expect(o.identity.fingerprint).toBe(p2.fingerprint);
    } else {
      throw new Error('expected result outcome');
    }
  });

  it('a failed server response carries the request identity and keeps inputs', async () => {
    const { store, calls } = setup();
    store.setPlanText('[1]');
    store.setLiveText('[1]');
    store.setKText('0');
    store.compare();
    await flush();
    const pending = store.getSnapshot().pending!;
    calls[0].reject(new FakeApiError('ARRAY_TOO_LONG', undefined, 400));
    await flush();
    const s = store.getSnapshot();
    expect(s.busy).toBe(false);
    expect(s.outcome?.kind).toBe('error');
    if (s.outcome?.kind === 'error') {
      expect(s.outcome.code).toBe('ARRAY_TOO_LONG');
      expect(s.outcome.identity).toEqual(pending);
    }
    expect(s.planText).toBe('[1]');
  });

  it('an overtaken failed request neither shows an error nor clears busy early', async () => {
    const { store, calls } = setup();
    store.setPlanText('[1]');
    store.setLiveText('[2]');
    store.setKText('2');
    store.compare();
    await flush();
    const first = calls.shift()!;

    store.setKText('1');
    store.compare();
    await flush();
    const second = calls.shift()!;

    second.resolve(distance('exceeded', 1, 1, 1));
    await flush();
    expect(store.getSnapshot().busy).toBe(true);
    first.reject(new FakeApiError('NETWORK', undefined));
    await flush();
    const s = store.getSnapshot();
    expect(s.busy).toBe(false);
    expect(s.outcome?.kind).toBe('result'); // #2 verdict survives
    if (s.outcome?.kind === 'result') {
      expect(s.outcome.identity.seq).toBe(2);
      expect(s.outcome.value.status).toBe('exceeded');
    }
  });
});
