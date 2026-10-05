import { DeviationStore, useStore } from './stores';

/** Independent entry 1: planned-vs-live cue sequence deviation checker. */
export default function DeviationChecker({ store }: { store: DeviationStore }) {
  const s = useStore(store);
  const { outcome } = s;

  return (
    <section>
      <section className="editors">
        <label className="editor">
          <span>计划 cue 序列（JSON 整数数组，≤ 50000 项）</span>
          <textarea
            value={s.planText}
            onChange={(e) => store.setPlanText(e.target.value)}
            spellCheck={false}
            rows={10}
            placeholder="[101, 102, 103]"
          />
        </label>
        <label className="editor">
          <span>现场触发序列（JSON 整数数组，≤ 50000 项）</span>
          <textarea
            value={s.liveText}
            onChange={(e) => store.setLiveText(e.target.value)}
            spellCheck={false}
            rows={10}
            placeholder="[101, 102, 104]"
          />
        </label>
      </section>

      <section className="controls">
        <label className="threshold">
          阈值 K（0–500）
          <input
            type="number"
            min={0}
            max={500}
            step={1}
            value={s.kText}
            onChange={(e) => store.setKText(e.target.value)}
          />
        </label>
        <button onClick={() => store.compare()} disabled={s.busy}>
          {s.busy ? '校验中…' : '比较'}
        </button>
      </section>

      {s.pending && (
        <p className="busy-note" role="status">
          校验请求 #{s.pending.seq} 进行中
          （{s.pending.lengths.a} / {s.pending.lengths.b} 项，K = {s.pending.k}，
          指纹 <code>{s.pending.fingerprint}</code>）：切换页签后，返回的结论仍归属于本次请求。
        </p>
      )}

      {outcome?.kind === 'error' && (
        <section className="verdict error" role="alert">
          <h2>❌ 输入无效</h2>
          {outcome.identity && <IdentityLine identity={outcome.identity} />}
          <p>
            <code>{outcome.code}</code>：{outcome.message}
          </p>
        </section>
      )}

      {outcome?.kind === 'result' && (
        <section
          className={outcome.value.status === 'ok' ? 'verdict ok' : 'verdict exceeded'}
          role="status"
        >
          <IdentityLine identity={outcome.identity} />
          {outcome.value.status === 'ok' ? (
            <>
              <h2>✅ 偏差在容许范围内</h2>
              <p className="headline">
                精确偏差距离 <strong>{outcome.value.distance}</strong> ≤ 阈值 K ={' '}
                {outcome.value.k}
              </p>
            </>
          ) : (
            <>
              <h2>⚠️ 偏差超出容许范围</h2>
              <p className="headline">
                实际偏差距离大于阈值 K = {outcome.value.k}（服务仅返回 exceeded 信号）
              </p>
            </>
          )}
          <dl className="facts">
            <div>
              <dt>计划长度</dt>
              <dd>{outcome.value.lengths.a}</dd>
            </div>
            <div>
              <dt>现场长度</dt>
              <dd>{outcome.value.lengths.b}</dd>
            </div>
            <div>
              <dt>长度差</dt>
              <dd>{Math.abs(outcome.value.lengths.a - outcome.value.lengths.b)}</dd>
            </div>
            <div>
              <dt>阈值 K</dt>
              <dd>{outcome.value.k}</dd>
            </div>
          </dl>
          <details>
            <summary>复核：原始响应</summary>
            <pre>{JSON.stringify(outcome.value, null, 2)}</pre>
          </details>
        </section>
      )}
    </section>
  );
}

/** Which request this verdict answers — distinguishes consecutive conclusions. */
function IdentityLine({
  identity,
}: {
  identity: { seq: number; fingerprint: string; lengths: { a: number; b: number }; k: number };
}) {
  return (
    <p className="identity-line">
      结论归属：请求 #{identity.seq}（{identity.lengths.a} / {identity.lengths.b} 项，
      K = {identity.k}，输入指纹 <code>{identity.fingerprint}</code>）
    </p>
  );
}
