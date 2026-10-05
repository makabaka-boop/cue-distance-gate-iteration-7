import { ConsoleStore, useStore, type ConsoleError } from './stores';
import type { Performance, PerformanceStatus } from './api';

const STATUS_LABELS: Record<PerformanceStatus, string> = {
  pending: '待演',
  running: '运行中',
  paused: '已暂停',
  ended: '已结束',
};

/** Independent entry 0: performance session console. */
export default function PerformanceConsole({ store }: { store: ConsoleStore }) {
  const s = useStore(store);
  const { session } = s;

  return (
    <section className="console">
      <div className="console-entry">
        <label className="field">
          <span>创建场次（舞台监督）</span>
          <span className="field-row">
            <input
              type="text"
              value={s.nameDraft}
              onChange={(e) => store.setName(e.target.value)}
              placeholder="场次名称，例如：9 月 17 日晚场"
              disabled={s.commandBusy}
            />
            <button onClick={() => store.create()} disabled={s.commandBusy}>
              创建
            </button>
          </span>
        </label>
        <label className="field">
          <span>按 ID 载入快照</span>
          <span className="field-row">
            <input
              type="text"
              value={s.loadIdDraft}
              onChange={(e) => store.setLoadId(e.target.value)}
              placeholder="场次 ID（UUID）"
              disabled={s.loadBusy}
              spellCheck={false}
            />
            <button className="secondary" onClick={() => store.load()} disabled={s.loadBusy}>
              {s.loadBusy ? '载入中…' : '载入'}
            </button>
          </span>
        </label>
      </div>

      <details className="plan-draft" open={s.planEnabledDraft}>
        <summary>
          <label className="plan-toggle">
            <input
              type="checkbox"
              checked={s.planEnabledDraft}
              onChange={(e) => store.setPlanEnabled(e.target.checked)}
              disabled={s.commandBusy}
            />
            附带固定计划 cue 序列与容许距离 K（可选；创建后封存，不随后续草稿改变）
          </label>
        </summary>
        {s.planEnabledDraft && (
          <div className="plan-draft-body">
            <label className="field">
              <span>计划 cue 序列（JSON 32 位整数数组，≤ 50000 项；可为空数组 []）</span>
              <textarea
                className="plan-textarea"
                value={s.planCuesDraft}
                onChange={(e) => store.setPlanCuesDraft(e.target.value)}
                placeholder="[101, 102, 103, 104, 105]"
                spellCheck={false}
                rows={4}
                disabled={s.commandBusy}
              />
            </label>
            <label className="field plan-k-field">
              <span>容许距离 K（0–500）</span>
              <input
                type="number"
                min={0}
                max={500}
                step={1}
                value={s.planKDraft}
                onChange={(e) => store.setPlanKDraft(e.target.value)}
                placeholder="如 3"
                disabled={s.commandBusy}
              />
            </label>
          </div>
        )}
      </details>

      {s.commandBusy && (
        <p className="busy-note" role="status">
          命令提交中…即使切换到偏差校验页，结果仍会回到本页场次。
        </p>
      )}

      {s.error && <ErrorBanner error={s.error} />}

      {!session && (
        <p className="console-empty">尚未打开场次：创建一场新演出，或按 ID 载入已有场次。</p>
      )}

      {session && (
        <article className="session">
          <header className="session-head">
            <div>
              <h2>{session.name}</h2>
              <p className="session-id" title={session.id}>
                ID：<code>{session.id}</code>
              </p>
            </div>
            <span className={`badge badge-${session.status}`}>
              {STATUS_LABELS[session.status]}
            </span>
          </header>

          <dl className="facts">
            <div>
              <dt>版本</dt>
              <dd>{session.version}</dd>
            </div>
            <div>
              <dt>已登记 cue</dt>
              <dd>{session.cues.length}</dd>
            </div>
            <div className="fact-wide">
              <dt>最近提交请求标识</dt>
              <dd>
                <code>{session.requestId ?? '—'}</code>
              </dd>
            </div>
          </dl>

          <DeviationPanel session={session} />

          {session.status === 'pending' && (
            <div className="actions">
              <button onClick={() => store.transition('running')} disabled={s.commandBusy}>
                开演（待演 → 运行）
              </button>
            </div>
          )}

          {session.status === 'running' && (
            <>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => store.transition('paused')}
                  disabled={s.commandBusy}
                >
                  暂停
                </button>
                <button
                  className="danger"
                  onClick={() => store.transition('ended')}
                  disabled={s.commandBusy}
                >
                  结束
                </button>
              </div>
              <div className="cue-entry">
                <label className="field">
                  <span>逐条登记整数 cue（仅运行态可写入；提交后才清空，失败可重试）</span>
                  <span className="field-row">
                    <input
                      type="number"
                      step={1}
                      value={s.cueDraft}
                      onChange={(e) => store.setCueDraft(e.target.value)}
                      placeholder="整数 cue，如 101"
                      disabled={s.commandBusy}
                    />
                    <button onClick={() => store.registerCue()} disabled={s.commandBusy}>
                      {s.commandBusy ? '提交中…' : '登记'}
                    </button>
                  </span>
                </label>
              </div>
            </>
          )}

          {session.status === 'paused' && (
            <div className="actions">
              <button onClick={() => store.transition('running')} disabled={s.commandBusy}>
                继续（→ 运行）
              </button>
              <button
                className="danger"
                onClick={() => store.transition('ended')}
                disabled={s.commandBusy}
              >
                结束
              </button>
            </div>
          )}

          <Timeline session={session} />
        </article>
      )}
    </section>
  );
}

function ErrorBanner({ error }: { error: ConsoleError }) {
  return (
    <div className="verdict error console-error" role="alert">
      <strong>
        <code>{error.code}</code>
        {error.reason ? (
          <>
            {' '}
            / <code>{error.reason}</code>
          </>
        ) : null}
      </strong>
      <span>{error.message}</span>
      <span className="error-hint">当前场次保留在页面上，数据未被改动。</span>
    </div>
  );
}

/**
 * Per-version deviation hint. Everything shown here is read from the single
 * session snapshot on screen, so the hint, the version number and the
 * timeline always describe the same version: a late response for another
 * session (or an older version) is filtered out before it reaches this view
 * and can never mix conclusions here.
 */
function DeviationPanel({ session }: { session: Performance }) {
  const { plan, deviation } = session;
  if (!plan || !deviation) {
    return (
      <p className="plan-legacy-note">该场次创建时未附计划 cue 序列，按原流程登记，不做偏差校验。</p>
    );
  }

  const ended = session.status === 'ended';
  const verdictClass = ended
    ? deviation.final?.status === 'ok'
      ? 'verdict ok'
      : 'verdict exceeded'
    : deviation.recoverable
      ? 'verdict ok'
      : 'verdict exceeded';

  return (
    <section className={verdictClass} role="status" data-version={session.version}>
      <p className="identity-line">偏差状态归属：场次版本 #{session.version}</p>
      {ended && deviation.final ? (
        deviation.final.status === 'ok' ? (
          <>
            <h2>✅ 终局：偏差在容许范围内</h2>
            <p className="headline">
              完整计划最终距离 <strong>{deviation.final.distance}</strong> ≤ 容许距离 K ={' '}
              {plan.k}
            </p>
          </>
        ) : (
          <>
            <h2>⚠️ 终局：偏差超出容许范围</h2>
            <p className="headline">
              完整序列最终距离大于容许距离 K = {plan.k}（仅返回 exceeded 信号）
            </p>
          </>
        )
      ) : deviation.recoverable ? (
        <>
          <h2>✅ 仍可追回</h2>
          <p className="headline">
            当前偏差边界 <strong>{deviation.boundary}</strong> ≤ 容许距离 K = {plan.k}
            ：已登记 {deviation.liveLength} 条现场 cue，至少某一计划前缀仍可在预算内对齐。
          </p>
        </>
      ) : (
        <>
          <h2>⚠️ 已超出容许范围</h2>
          <p className="headline">
            偏差边界已大于容许距离 K = {plan.k}：继续演出无法再追回（边界只会增长）。
          </p>
        </>
      )}
      <dl className="facts deviation-facts">
        <div>
          <dt>计划 cue</dt>
          <dd>{deviation.plannedLength}</dd>
        </div>
        <div>
          <dt>现场 cue</dt>
          <dd>{deviation.liveLength}</dd>
        </div>
        <div>
          <dt>当前边界</dt>
          <dd>{deviation.boundary > plan.k ? `>${plan.k}` : deviation.boundary}</dd>
        </div>
        <div>
          <dt>容许 K</dt>
          <dd>{plan.k}</dd>
        </div>
      </dl>
      <details className="plan-sealed">
        <summary>固定计划（创建时封存，不随页面草稿改变）</summary>
        <pre>{JSON.stringify(plan.cues)}</pre>
      </details>
    </section>
  );
}

function Timeline({ session }: { session: Performance }) {
  const sealed = session.status === 'ended';
  return (
    <div className={`timeline${sealed ? ' sealed' : ''}`}>
      <h3>
        {sealed ? '封存时间线（只读）' : '现场时间线'}
        <span className="timeline-count">{session.cues.length} 条</span>
      </h3>
      {session.cues.length === 0 ? (
        <p className="timeline-empty">暂无 cue。</p>
      ) : (
        <ol className="cue-list">
          {session.cues.map((cue, i) => (
            <li key={i}>
              <span className="cue-index">#{i + 1}</span>
              <span className="cue-value">{cue}</span>
            </li>
          ))}
        </ol>
      )}
      {sealed && <p className="sealed-note">场次已结束，时间线封存，不再接受写入。</p>}
    </div>
  );
}
