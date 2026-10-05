import DeviationChecker from './DeviationChecker';
import PerformanceConsole from './PerformanceConsole';
import { ConsoleStore, DeviationStore } from './stores';
import { useState } from 'react';

type Tab = 'console' | 'deviation';

const TABS: { id: Tab; label: string }[] = [
  { id: 'console', label: '演出场次控制台' },
  { id: 'deviation', label: 'Cue 序列偏差校验' },
];

export interface AppStores {
  console: ConsoleStore;
  deviation: DeviationStore;
}

// Module singletons: the two entries are independent of each other and live
// for the whole page lifetime, so switching tabs hides a panel instead of
// unmounting it — sessions, drafts, errors, busy flags and in-flight request
// identities all survive the round-trip.
const defaultStores: AppStores = {
  console: new ConsoleStore(),
  deviation: new DeviationStore(),
};

export default function App({ stores = defaultStores }: { stores?: AppStores }) {
  const [tab, setTab] = useState<Tab>('console');

  return (
    <main className="page">
      <header>
        <h1>舞台监督工作台</h1>
        <p className="subtitle">
          演出场次的创建、运行控制与 cue 登记；另附计划/现场 cue 序列偏差校验入口。
        </p>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            id={`tab-${t.id}`}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/*
        Both panels stay mounted (hidden via the `hidden` attribute): the
        stage manager toggles to the deviation check mid-command and comes
        back to find the exact session, drafts and busy state — and an
        in-flight answer still reaches its (never-destroyed) store.
      */}
      <div
        role="tabpanel"
        id="panel-console"
        aria-labelledby="tab-console"
        hidden={tab !== 'console'}
      >
        <PerformanceConsole store={stores.console} />
      </div>
      <div
        role="tabpanel"
        id="panel-deviation"
        aria-labelledby="tab-deviation"
        hidden={tab !== 'deviation'}
      >
        <DeviationChecker store={stores.deviation} />
      </div>
    </main>
  );
}
