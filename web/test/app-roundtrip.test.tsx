import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { ConsoleStore, DeviationStore } from '../src/stores';
import {
  controlledConsoleDeps,
  controlledDeviationDeps,
  distance,
  flush,
  perf,
  type Deferred,
} from './helpers';
import type { DistanceResponse } from '../src/api';

afterEach(() => {
  vi.restoreAllMocks();
});

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
function deviationPanel(): HTMLElement {
  return document.getElementById('panel-deviation')!;
}

const goConsole = () => fireEvent.click(screen.getByRole('tab', { name: '演出场次控制台' }));
const goDeviation = () => fireEvent.click(screen.getByRole('tab', { name: 'Cue 序列偏差校验' }));

/** Let React flush the queued promise continuations. */
async function settle<T>(d: Deferred<T>, value: T) {
  await act(async () => {
    d.resolve(value);
    await flush();
  });
}
async function rejectWith(d: Deferred<unknown>, err: unknown) {
  await act(async () => {
    d.reject(err);
    await flush();
  });
}

describe('tab round-trip: both panels stay mounted', () => {
  it('console session, name, load id and cue draft survive a deviation round-trip', async () => {
    const app = makeApp();
    const view = render(<App stores={app.stores} />);

    // Open session A at running v2.
    fireEvent.change(within(consolePanel()).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '9 月 17 日晚场' },
    });
    fireEvent.click(within(consolePanel()).getByRole('button', { name: '创建' }));
    await settle(app.commands.shift()!, perf({
      id: 'A',
      name: '9 月 17 日晚场',
      status: 'pending',
      version: 1,
      requestId: 'r1',
    }));
    fireEvent.click(within(consolePanel()).getByRole('button', { name: /开演/ }));
    await settle(app.commands.shift()!, perf({
      id: 'A',
      name: '9 月 17 日晚场',
      status: 'running',
      version: 2,
      requestId: 'r2',
    }));

    fireEvent.change(within(consolePanel()).getByPlaceholderText('场次 ID（UUID）'), {
      target: { value: 'typed-load-id' },
    });
    const cueInput = await waitFor(() =>
      within(consolePanel()).getByPlaceholderText('整数 cue，如 101'),
    );
    fireEvent.change(cueInput, {
      target: { value: '777' },
    });

    // Both panels are mounted; only one visible at a time.
    expect(consolePanel().hidden).toBe(false);
    expect(deviationPanel().hidden).toBe(true);
    expect(consolePanel().textContent).toContain('9 月 17 日晚场');

    goDeviation();
    expect(consolePanel().hidden).toBe(true);
    expect(deviationPanel().hidden).toBe(false);
    // DOM of the hidden console is still present (not unmounted).
    expect(consolePanel().textContent).toContain('9 月 17 日晚场');
    expect(within(consolePanel()).getByDisplayValue('777')).toBeTruthy();
    expect(within(consolePanel()).getByDisplayValue('typed-load-id')).toBeTruthy();

    // Type something in the deviation entry while away.
    fireEvent.change(within(deviationPanel()).getAllByRole('textbox')[0], {
      target: { value: '[10, 20]' },
    });

    goConsole();
    expect(consolePanel().hidden).toBe(false);
    expect(within(consolePanel()).getByDisplayValue('777')).toBeTruthy();
    expect(within(consolePanel()).getByDisplayValue('typed-load-id')).toBeTruthy();
    expect(within(consolePanel()).getByText('版本').nextElementSibling?.textContent).toBe('2');
    // Deviation input survives too.
    goDeviation();
    expect(within(deviationPanel()).getByDisplayValue('[10, 20]')).toBeTruthy();

    view.unmount();
  });

  it('cue submitted mid-round-trip: busy and draft persist; success updates only A', async () => {
    const app = makeApp();
    render(<App stores={app.stores} />);

    fireEvent.change(within(consolePanel()).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '晚场' },
    });
    fireEvent.click(within(consolePanel()).getByRole('button', { name: '创建' }));
    await settle(app.commands.shift()!, perf({ id: 'A', name: '晚场', version: 1, status: 'pending' }));
    fireEvent.click(within(consolePanel()).getByRole('button', { name: /开演/ }));
    await settle(app.commands.shift()!, perf({
      id: 'A',
      name: '晚场',
      version: 2,
      status: 'running',
    }));

    const cueInput = await waitFor(() =>
      within(consolePanel()).getByPlaceholderText('整数 cue，如 101'),
    );
    fireEvent.change(cueInput, {
      target: { value: '101' },
    });
    fireEvent.click(within(consolePanel()).getByRole('button', { name: '登记' }));

    // Switch BEFORE the response: busy note and draft are still there.
    goDeviation();
    await act(async () => {
      await flush();
    });
    goConsole();
    expect(within(consolePanel()).getByText(/命令提交中/)).toBeTruthy();
    expect(within(consolePanel()).getByDisplayValue('101')).toBeTruthy();
    expect(app.commands).toHaveLength(1);

    // Response after return: v3, one cue, draft consumed, busy gone.
    await settle(app.commands.shift()!, perf({
      id: 'A',
      name: '晚场',
      version: 3,
      status: 'running',
      requestId: 'r-cue',
      cues: [101],
    }));
    const panel = consolePanel();
    expect(panel.textContent).toContain('#1');
    expect(panel.textContent).toContain('101');
    expect(within(panel).queryByText(/命令提交中/)).toBeNull();
    expect(within(panel).queryByDisplayValue('101')).toBeNull();
    expect(within(panel).getByText('版本').nextElementSibling?.textContent).toBe('3');
  });

  it('failed command after round-trip keeps snapshot, error and draft; deviation untouched', async () => {
    const app = makeApp();
    render(<App stores={app.stores} />);

    fireEvent.change(within(consolePanel()).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '晚场' },
    });
    fireEvent.click(within(consolePanel()).getByRole('button', { name: '创建' }));
    await settle(app.commands.shift()!, perf({ id: 'A', name: '晚场', version: 1, status: 'pending' }));
    fireEvent.click(within(consolePanel()).getByRole('button', { name: /开演/ }));
    await settle(app.commands.shift()!, perf({ id: 'A', name: '晚场', version: 2, status: 'running' }));

    // First establish a deviation verdict in the other entry.
    goDeviation();
    fireEvent.click(within(deviationPanel()).getByRole('button', { name: '比较' }));
    await act(async () => {
      await flush();
    });
    await settle(app.calls.shift()! as Deferred<DistanceResponse>, distance(0, 3, 8, 7));
    expect(within(deviationPanel()).getByText(/偏差在容许范围内/)).toBeTruthy();

    goConsole();
    const cueInput = await waitFor(() =>
      within(consolePanel()).getByPlaceholderText('整数 cue，如 101'),
    );
    fireEvent.change(cueInput, {
      target: { value: '202' },
    });
    fireEvent.click(within(consolePanel()).getByRole('button', { name: '登记' }));
    goDeviation();
    await act(async () => {
      await flush();
    });
    goConsole();

    class ApiErr extends Error {
      code = 'COMMAND_REJECTED';
      reason = 'VERSION_CONFLICT';
      status = 409;
    }
    await rejectWith(app.commands.shift()! as unknown as Deferred<unknown>, new ApiErr());

    const panel = consolePanel();
    expect(within(panel).getByText('VERSION_CONFLICT')).toBeTruthy();
    expect(within(panel).getByDisplayValue('202')).toBeTruthy();
    expect(within(panel).getByText('版本').nextElementSibling?.textContent).toBe('2');
    expect(within(panel).queryByText(/命令提交中/)).toBeNull();

    // The other entry's verdict is completely intact.
    goDeviation();
    expect(within(deviationPanel()).getByText(/偏差在容许范围内/)).toBeTruthy();
    expect(within(deviationPanel()).queryByText('VERSION_CONFLICT')).toBeNull();
  });

  it('deviation request sent before switching: pending identity and verdict stay attributable', async () => {
    const app = makeApp();
    render(<App stores={app.stores} />);
    goDeviation();

    fireEvent.change(within(deviationPanel()).getAllByRole('textbox')[0], {
      target: { value: '[1, 2, 3]' },
    });
    fireEvent.change(within(deviationPanel()).getAllByRole('textbox')[1], {
      target: { value: '[1, 3]' },
    });
    const kInput = within(deviationPanel()).getByDisplayValue('3');
    fireEvent.change(kInput, { target: { value: '1' } });

    fireEvent.click(within(deviationPanel()).getByRole('button', { name: '比较' }));
    await act(async () => {
      await flush();
    });
    expect(within(deviationPanel()).getByText(/校验请求 #1 进行中/)).toBeTruthy();

    // Switch to the console while the request flies, then come back.
    goConsole();
    expect(consolePanel().hidden).toBe(false);
    goDeviation();
    expect(within(deviationPanel()).getByText(/校验请求 #1 进行中/)).toBeTruthy();

    await settle(app.calls.shift()! as Deferred<DistanceResponse>, distance(1, 1, 3, 2));
    expect(within(deviationPanel()).getByText(/偏差在容许范围内/)).toBeTruthy();
    expect(within(deviationPanel()).getByText(/结论归属：请求 #1/)).toBeTruthy();
    expect(within(deviationPanel()).queryByText(/校验请求/)).toBeNull();
    // Inputs are preserved for the next calculation.
    expect(within(deviationPanel()).getByDisplayValue('[1, 2, 3]')).toBeTruthy();
    expect(within(deviationPanel()).getByDisplayValue('[1, 3]')).toBeTruthy();
    expect(within(deviationPanel()).getByDisplayValue('1')).toBeTruthy();
  });

  it('works end-to-end with default stores (no DI regressions)', () => {
    render(<App />);
    expect(document.getElementById('panel-console')).toBeTruthy();
    expect(document.getElementById('panel-deviation')).toBeTruthy();
    goDeviation();
    expect(deviationPanel().hidden).toBe(false);
  });
});
