import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { ConsoleStore, DeviationStore } from '../src/stores';
import { controlledConsoleDeps, controlledDeviationDeps, flush, perf } from './helpers';

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

async function settle<T>(deferred: { resolve: (value: T) => void }, value: T) {
  await act(async () => {
    deferred.resolve(value);
    await flush();
  });
}

describe('cue correction UI', () => {
  it('shows the correction form only while paused and displays effective cues separately from audit records', async () => {
    const app = makeApp();
    render(<App stores={app.stores} />);
    const panel = consolePanel();

    fireEvent.change(within(panel).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '暂停更正' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '创建' }));
    await settle(
      app.commands.shift()!,
      perf({ id: 'P', name: '暂停更正', status: 'pending', version: 1 }),
    );

    fireEvent.click(within(panel).getByRole('button', { name: /开演/ }));
    await settle(
      app.commands.shift()!,
      perf({ id: 'P', status: 'running', version: 2 }),
    );
    expect(within(panel).queryByText(/暂停核查：更正已登记 cue/)).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: '暂停' }));
    await settle(
      app.commands.shift()!,
      perf({ id: 'P', status: 'paused', version: 3, cues: [101, 999], corrections: [] }),
    );

    const heading = await waitFor(() => screen.getByText(/暂停核查：更正已登记 cue/));
    expect(heading).toBeTruthy();

    const inputs = panel.querySelectorAll('.correction-form input');
    fireEvent.change(inputs[0]!, { target: { value: '2' } });
    fireEvent.change(inputs[1]!, { target: { value: '999' } });
    fireEvent.change(inputs[2]!, { target: { value: '102' } });
    fireEvent.click(within(panel).getByRole('button', { name: '提交更正' }));
    await act(async () => {
      await flush();
    });

    expect(app.commands[0]!.payload).toMatchObject({
      command: 'correctCue',
      performanceId: 'P',
      position: 2,
      oldCue: 999,
      newCue: 102,
      expectedVersion: 3,
    });

    await settle(
      app.commands.shift()!,
      perf({
        id: 'P',
        status: 'paused',
        version: 4,
        requestId: 'correct',
        cues: [101, 102],
        corrections: [{ position: 2, oldCue: 999, newCue: 102, version: 4 }],
      }),
    );

    const timeline = within(panel).getByText('现场时间线').closest('.timeline')!;
    expect(timeline.textContent).toContain('102');
    expect(timeline.textContent).not.toContain('999');
    expect(within(panel).getByText(/^更正记录（/)).toBeTruthy();
    const correctionLog = panel.querySelector('.correction-log')!;
    expect(correctionLog.textContent).toContain('999');
    expect(correctionLog.textContent).toContain('102');
    expect(within(panel).getByText(/提交版本 #4/)).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: '结束' }));
    await settle(
      app.commands.shift()!,
      perf({
        id: 'P',
        status: 'ended',
        version: 5,
        cues: [101, 102],
        corrections: [{ position: 2, oldCue: 999, newCue: 102, version: 4 }],
      }),
    );
    expect(within(panel).queryByText(/暂停核查：更正已登记 cue/)).toBeNull();
    expect(within(panel).getByText(/封存时间线（只读）/)).toBeTruthy();
  });
});
