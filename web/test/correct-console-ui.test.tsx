import { act, fireEvent, render, within } from '@testing-library/react';
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

async function settle<T>(d: Deferred<T>, value: T) {
  await act(async () => {
    d.resolve(value);
    await flush();
  });
}

/** Create + start + register cues + pause, all through the real UI. */
async function openPausedWithCues(
  app: ReturnType<typeof makeApp>,
  cues: number[],
): Promise<void> {
  const panel = consolePanel();
  fireEvent.change(within(panel).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
    target: { value: '更正场次' },
  });
  fireEvent.click(within(panel).getByRole('button', { name: '创建' }));
  await settle(
    app.commands.shift()!,
    perf({ id: 'A', name: '更正场次', status: 'pending', version: 1 }),
  );
  fireEvent.click(within(panel).getByRole('button', { name: /开演/ }));
  await settle(app.commands.shift()!, perf({ id: 'A', status: 'running', version: 2 }));
  for (const [i, cue] of cues.entries()) {
    fireEvent.change(within(panel).getByPlaceholderText('整数 cue，如 101'), {
      target: { value: String(cue) },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '登记' }));
    await settle(
      app.commands.shift()!,
      perf({ id: 'A', status: 'running', version: 3 + i, cues: cues.slice(0, i + 1) }),
    );
  }
  fireEvent.click(within(panel).getByRole('button', { name: '暂停' }));
  await settle(
    app.commands.shift()!,
    perf({ id: 'A', status: 'paused', version: 2 + cues.length + 1, cues }),
  );
}

describe('cue correction UI', () => {
  it('offers per-row correction only while paused and records the audit entry on commit', async () => {
    const app = makeApp();
    render(<App stores={app.stores} />);
    await openPausedWithCues(app, [101, 202]);
    const panel = consolePanel();

    // Paused: every timeline row offers a correction button; no log yet.
    const correctButtons = within(panel).getAllByRole('button', { name: '更正' });
    expect(correctButtons).toHaveLength(2);
    expect(within(panel).queryByText('更正记录')).toBeNull();

    // Open the form for row #2: it shows the current effective value.
    fireEvent.click(correctButtons[1]!);
    expect(within(panel).getByText(/更正第 2 条/)).toBeTruthy();
    expect(within(panel).getByText(/当前生效值/)).toBeTruthy();
    expect(panel.textContent).toContain('202');

    // Cancel keeps everything; reopen and submit a replacement.
    fireEvent.click(within(panel).getByRole('button', { name: '取消' }));
    expect(within(panel).queryByText(/更正第 2 条/)).toBeNull();
    fireEvent.click(within(panel).getAllByRole('button', { name: '更正' })[1]!);
    fireEvent.change(within(panel).getByPlaceholderText('替换值（整数 cue）'), {
      target: { value: '303' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '提交更正' }));

    const payload = app.commands[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      command: 'correctCue',
      performanceId: 'A',
      position: 1,
      expectedOldValue: 202,
      cue: 303,
      expectedVersion: 5,
    });

    await settle(
      app.commands.shift()!,
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

    // Timeline shows only the effective value; the log keeps old -> new.
    const list = panel.querySelector('.cue-list')!;
    expect(list.textContent).toContain('303');
    expect(list.textContent).not.toContain('202');
    const log = panel.querySelector('.corrections-log')!;
    expect(log.textContent).toContain('更正记录');
    expect(log.textContent).toContain('#2');
    expect(log.textContent).toContain('202');
    expect(log.textContent).toContain('303');
    expect(log.textContent).toContain('提交于版本 #6');
    // The form closed after the commit.
    expect(within(panel).queryByText(/更正第 2 条/)).toBeNull();
  });

  it('never offers correction buttons while running or after sealing', async () => {
    const app = makeApp();
    render(<App stores={app.stores} />);
    const panel = consolePanel();

    fireEvent.change(within(panel).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '运行场次' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '创建' }));
    await settle(app.commands.shift()!, perf({ id: 'A', status: 'pending', version: 1 }));
    fireEvent.click(within(panel).getByRole('button', { name: /开演/ }));
    await settle(app.commands.shift()!, perf({ id: 'A', status: 'running', version: 2 }));
    fireEvent.change(within(panel).getByPlaceholderText('整数 cue，如 101'), {
      target: { value: '7' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '登记' }));
    await settle(
      app.commands.shift()!,
      perf({ id: 'A', status: 'running', version: 3, cues: [7] }),
    );
    // Running: no correction affordance.
    expect(within(panel).queryAllByRole('button', { name: '更正' })).toHaveLength(0);

    // Pause -> correct -> resume -> end: the sealed timeline offers nothing.
    fireEvent.click(within(panel).getByRole('button', { name: '暂停' }));
    await settle(app.commands.shift()!, perf({ id: 'A', status: 'paused', version: 4, cues: [7] }));
    expect(within(panel).getAllByRole('button', { name: '更正' })).toHaveLength(1);

    fireEvent.click(within(panel).getAllByRole('button', { name: '更正' })[0]!);
    fireEvent.change(within(panel).getByPlaceholderText('替换值（整数 cue）'), {
      target: { value: '8' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '提交更正' }));
    await settle(
      app.commands.shift()!,
      perf({
        id: 'A',
        status: 'paused',
        version: 5,
        cues: [8],
        corrections: [{ position: 0, oldValue: 7, newValue: 8, version: 5, requestId: 'rq' }],
      }),
    );

    fireEvent.click(within(panel).getByRole('button', { name: /继续/ }));
    await settle(
      app.commands.shift()!,
      perf({
        id: 'A',
        status: 'running',
        version: 6,
        cues: [8],
        corrections: [{ position: 0, oldValue: 7, newValue: 8, version: 5, requestId: 'rq' }],
      }),
    );
    expect(within(panel).queryAllByRole('button', { name: '更正' })).toHaveLength(0);

    fireEvent.click(within(panel).getByRole('button', { name: '结束' }));
    await settle(
      app.commands.shift()!,
      perf({
        id: 'A',
        status: 'ended',
        version: 7,
        cues: [8],
        corrections: [{ position: 0, oldValue: 7, newValue: 8, version: 5, requestId: 'rq' }],
      }),
    );
    // Sealed: no correction buttons; the audit log stays viewable.
    expect(within(panel).queryAllByRole('button', { name: '更正' })).toHaveLength(0);
    expect(within(panel).getByText(/封存时间线/)).toBeTruthy();
    expect(panel.querySelector('.corrections-log')?.textContent).toContain('提交于版本 #5');
  });
});
