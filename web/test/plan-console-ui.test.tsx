import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { ConsoleStore, DeviationStore } from '../src/stores';
import {
  controlledConsoleDeps,
  controlledDeviationDeps,
  flush,
  perf,
  type Deferred,
} from './helpers';
import type { Performance } from '../src/api';

function makeApp() {
  const c = controlledConsoleDeps();
  const d = controlledDeviationDeps();
  const stores = {
    console: new ConsoleStore(c.deps),
    deviation: new DeviationStore(d.deps),
  };
  return { ...c, ...d, stores };
}

function consolePanel(): HTMLElement {
  return document.getElementById('panel-console')!;
}

const goConsole = () => fireEvent.click(screen.getByRole('tab', { name: '演出场次控制台' }));
const goDeviation = () => fireEvent.click(screen.getByRole('tab', { name: 'Cue 序列偏差校验' }));

async function settle<T>(d: Deferred<T>, value: T) {
  await act(async () => {
    d.resolve(value);
    await flush();
  });
}

function snap(
  over: Partial<Performance> & { id: string },
  deviation: Performance['deviation'] = null,
  plan: Performance['plan'] = null,
): Performance {
  return perf({ ...over, plan, deviation });
}

describe('planned-session deviation hint UI', () => {
  it('shows legacy note for an unplanned session and the per-version hint for a planned one', async () => {
    const app = makeApp();
    render(<App stores={app.stores} />);

    // Legacy create (toggle off).
    fireEvent.change(within(consolePanel()).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '旧场次' },
    });
    fireEvent.click(within(consolePanel()).getByRole('button', { name: '创建' }));
    await settle(
      app.commands.shift()!,
      snap({ id: 'L', name: '旧场次', status: 'pending', version: 1 }),
    );
    expect(within(consolePanel()).getByText(/未附计划 cue 序列/)).toBeTruthy();
  });

  it('renders recoverable then exceeded then final verdict, always labelled with the snapshot version', async () => {
    const app = makeApp();
    render(<App stores={app.stores} />);
    const panel = consolePanel();

    // Create with a plan [1,2,3], k = 1.
    fireEvent.change(within(panel).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '晚场带计划' },
    });
    fireEvent.click(within(panel).getByText(/附带固定计划/));
    fireEvent.change(within(panel).getByPlaceholderText('[101, 102, 103, 104, 105]'), {
      target: { value: '[1, 2, 3]' },
    });
    const kBox = within(panel).getByPlaceholderText('如 3');
    fireEvent.change(kBox, { target: { value: '1' } });
    fireEvent.click(within(panel).getByRole('button', { name: '创建' }));

    await settle(
      app.commands.shift()!,
      snap(
        { id: 'P', name: '晚场带计划', status: 'pending', version: 1, requestId: 'c' },
        {
          k: 1,
          plannedLength: 3,
          liveLength: 0,
          boundary: 0,
          recoverable: true,
          final: null,
        },
        { cues: [1, 2, 3], k: 1 },
      ),
    );
    // The created session shows the sealed plan, boundary 0, version #1.
    expect(within(panel).getByText(/偏差状态归属：场次版本 #1/)).toBeTruthy();
    expect(within(panel).getByText(/仍可追回/)).toBeTruthy();
    // The sealed plan (<pre> in the verdict), not the still-editable draft.
    expect(within(panel).getByText('固定计划（创建时封存，不随页面草稿改变）')).toBeTruthy();
    expect(panel.querySelector('details.plan-sealed pre')?.textContent).toBe('[1,2,3]');

    fireEvent.click(within(panel).getByRole('button', { name: /开演/ }));
    await settle(
      app.commands.shift()!,
      snap(
        { id: 'P', status: 'running', version: 2, requestId: 's' },
        { k: 1, plannedLength: 3, liveLength: 0, boundary: 0, recoverable: true, final: null },
        { cues: [1, 2, 3], k: 1 },
      ),
    );
    expect(within(panel).getByText(/场次版本 #2/)).toBeTruthy();

    // Cue 1 matches: still recoverable at v3.
    fireEvent.change(await waitFor(() => within(panel).getByPlaceholderText('整数 cue，如 101')), {
      target: { value: '1' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '登记' }));
    await settle(
      app.commands.shift()!,
      snap(
        { id: 'P', status: 'running', version: 3, requestId: 'q1', cues: [1] },
        { k: 1, plannedLength: 3, liveLength: 1, boundary: 0, recoverable: true, final: null },
        { cues: [1, 2, 3], k: 1 },
      ),
    );
    expect(within(panel).getByText(/场次版本 #3/)).toBeTruthy();
    expect(within(panel).getByText(/仍可追回/)).toBeTruthy();

    // Tab round-trip while everything is settled: same version/hint visible.
    goDeviation();
    goConsole();
    expect(within(panel).getByText(/场次版本 #3/)).toBeTruthy();
    expect(within(panel).getByText(/仍可追回/)).toBeTruthy();

    // Two stray cues -> exceeded at v4 (boundary k+1 shown as >1).
    fireEvent.change(within(panel).getByPlaceholderText('整数 cue，如 101'), {
      target: { value: '8' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '登记' }));
    await settle(
      app.commands.shift()!,
      snap(
        { id: 'P', status: 'running', version: 4, requestId: 'q2', cues: [1, 8] },
        { k: 1, plannedLength: 3, liveLength: 2, boundary: 2, recoverable: false, final: null },
        { cues: [1, 2, 3], k: 1 },
      ),
    );
    expect(within(panel).getByText(/场次版本 #4/)).toBeTruthy();
    expect(within(panel).getByText(/已超出容许范围/)).toBeTruthy();
    expect(within(panel).getByText(/>1/)).toBeTruthy();

    // End: final verdict against the whole plan.
    fireEvent.click(within(panel).getByRole('button', { name: '结束' }));
    await settle(
      app.commands.shift()!,
      snap(
        { id: 'P', status: 'ended', version: 5, requestId: 'e', cues: [1, 8] },
        { k: 1, plannedLength: 3, liveLength: 2, boundary: 2, recoverable: false, final: { status: 'exceeded' } },
        { cues: [1, 2, 3], k: 1 },
      ),
    );
    expect(within(panel).getByText(/场次版本 #5/)).toBeTruthy();
    expect(within(panel).getByText(/终局：偏差超出容许范围/)).toBeTruthy();
  });
});
