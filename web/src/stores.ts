/**
 * Framework-agnostic stores for the two independent workbench entries.
 *
 * The stage manager switches between the performance console and the
 * deviation checker mid-operation (e.g. while a command is still in flight)
 * and expects everything to be exactly as left behind on return. The views
 * therefore never unmount: both panels stay mounted for the page's life and
 * each owns an isolated store instance. Neither store can read or reset the
 * other — a failed command in the console can never touch a deviation
 * verdict, and vice versa.
 *
 * The adjudication rules (global requestId arbitration, expectedVersion
 * conflicts, the distance algorithm) all live server-side and are unchanged;
 * these stores only decide *which arriving response is allowed to touch the
 * view*.
 */
import { useSyncExternalStore } from 'react';
import {
  ApiError,
  fetchDistance,
  loadPerformance,
  newRequestId as defaultNewRequestId,
  submitPerformanceCommand,
  type DistanceResponse,
  type Performance,
  type PerformanceCommand as CommandEnvelope,
  type PerformanceStatus,
} from './api';

// ------------------------------------------------------------------ helpers

export class ClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
  }
}

export interface ConsoleError {
  code: string;
  reason?: string;
  message: string;
}

function toConsoleError(err: unknown): ConsoleError {
  if (err instanceof ClientError) {
    return { code: err.code, message: err.message };
  }
  // Structured recognition rather than instanceof: wire errors rehydrated in
  // tests (or across realms) still carry the stable code/reason fields.
  if (err instanceof Error && 'code' in err) {
    const e = err as ApiError;
    return { code: e.code, reason: e.reason, message: e.message };
  }
  return { code: 'NETWORK', message: '无法连接服务，请确认 API 已启动。' };
}

function parseInt32(text: string): number {
  const t = text.trim();
  if (t === '') throw new ClientError('INVALID_CUE', '请输入整数 cue。');
  const n = Number(t);
  if (!Number.isInteger(n)) throw new ClientError('INVALID_CUE', 'cue 必须是整数。');
  if (n < -2147483648 || n > 2147483647) {
    throw new ClientError('INVALID_CUE', 'cue 必须是 32 位有符号整数。');
  }
  return n;
}

function parseJsonArray(text: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ClientError(
      'INVALID_JSON',
      `${label}不是合法的 JSON，请输入标准 JSON 数组（例如 [1, 2, 3]）。`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ClientError('INVALID_BODY', `${label}必须是 JSON 数组。`);
  }
  return parsed;
}

/** Parse a JSON array of 32-bit signed integers (the fixed creation plan). */
function parseJsonInt32Array(text: string, label: string): number[] {
  const values = parseJsonArray(text, label);
  if (values.length > 50_000) {
    throw new ClientError('ARRAY_TOO_LONG', `${label}最多 50000 项。`);
  }
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < -2147483648 || v > 2147483647) {
      throw new ClientError('INVALID_ELEMENT', `${label}第 ${i + 1} 项必须是 32 位有符号整数。`);
    }
  }
  return values as number[];
}

function parseK(text: string): number {
  const k = Number(text);
  if (text.trim() === '' || !Number.isInteger(k) || k < 0 || k > 500) {
    throw new ClientError('INVALID_K', '阈值 K 必须是 0 到 500 之间的整数。');
  }
  return k;
}

/** FNV-1a (32 bit) fingerprint so two verdicts can be told apart at a glance. */
function fingerprint(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// -------------------------------------------------------------- store scaffold

abstract class Store<S> {
  protected state: S;
  private listeners = new Set<() => void>();

  constructor(initial: S) {
    this.state = initial;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): S => this.state;

  protected patch(partial: Partial<S>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

export function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

// ------------------------------------------------------------ console store

export interface ConsoleState {
  /** The session currently on screen; survives tab switches untouched. */
  session: Performance | null;
  error: ConsoleError | null;
  commandBusy: boolean;
  loadBusy: boolean;
  nameDraft: string;
  loadIdDraft: string;
  /** Cue text the stage manager typed; it is only consumed on a commit. */
  cueDraft: string;
  /**
   * Optional fixed-plan drafts for the *next* create command. They remain
   * editable page drafts until a create commits and can never alter the plan
   * of an already created session.
   */
  planEnabledDraft: boolean;
  planCuesDraft: string;
  planKDraft: string;
}

export interface ConsoleDeps {
  submit: (command: CommandEnvelope) => Promise<Performance>;
  load: (id: string) => Promise<Performance>;
  newRequestId: () => string;
}

const defaultConsoleDeps: ConsoleDeps = {
  submit: submitPerformanceCommand,
  load: loadPerformance,
  newRequestId: defaultNewRequestId,
};

export class ConsoleStore extends Store<ConsoleState> {
  private readonly deps: ConsoleDeps;

  /**
   * Monotonic token of the latest user-initiated request, tracked
   * separately per request kind: a command and a load may be in flight at
   * once and settle in any order, and neither kind supersedes the other. A
   * failed cue followed by a retry must therefore still surface its error
   * even though a load happened in between.
   */
  private commandGeneration = 0;
  private loadGeneration = 0;
  /**
   * Monotonic token of the latest action that may switch the displayed
   * session. A snapshot arriving for a superseded action is only allowed to
   * catch the same session up in version; it can never replace the newer one.
   */
  private viewGeneration = 0;
  private sessionRef: Performance | null = null;
  private commandInFlight = 0;
  private loadInFlight = 0;
  /**
   * Sessions that currently have an in-flight registerCue. A cue draft is
   * consumed only by a response belonging to the session the box is showing.
   */
  private pendingCueSessions = new Set<string>();

  constructor(deps: ConsoleDeps = defaultConsoleDeps) {
    super({
      session: null,
      error: null,
      commandBusy: false,
      loadBusy: false,
      nameDraft: '',
      loadIdDraft: '',
      cueDraft: '',
      planEnabledDraft: false,
      planCuesDraft: '',
      planKDraft: '',
    });
    this.deps = deps;
  }

  setName(nameDraft: string): void {
    this.patch({ nameDraft });
  }

  setLoadId(loadIdDraft: string): void {
    this.patch({ loadIdDraft });
  }

  setCueDraft(cueDraft: string): void {
    this.patch({ cueDraft });
  }

  setPlanEnabled(planEnabledDraft: boolean): void {
    this.patch({ planEnabledDraft });
  }

  setPlanCuesDraft(planCuesDraft: string): void {
    this.patch({ planCuesDraft });
  }

  setPlanKDraft(planKDraft: string): void {
    this.patch({ planKDraft });
  }

  /**
   * Merge an arriving snapshot with the one on screen. Loads and commands may
   * be in flight simultaneously and settle in any order. A response belonging
   * to the latest user action may switch the displayed session, but a GET must
   * never downgrade a version a command already committed. A superseded
   * response may only catch the *same* session up in version — it can never
   * switch sessions or roll a version backwards.
   */
  private adoptSnapshot(next: Performance, stale: boolean): void {
    const current = this.sessionRef;
    if (stale) {
      if (!current || current.id !== next.id || next.version <= current.version) {
        return;
      }
    } else if (current && current.id === next.id && current.version > next.version) {
      return;
    }
    this.sessionRef = next;
    this.patch({ session: next });
  }

  private runCommand(
    action: () => Promise<Performance>,
    targetSessionId: string | null,
    cueSessionId?: string,
  ): void {
    const cmdGen = ++this.commandGeneration;
    const viewGen = ++this.viewGeneration;
    this.commandInFlight += 1;
    this.patch({ commandBusy: true, error: null });
    if (cueSessionId) this.pendingCueSessions.add(cueSessionId);
    void action().then(
      (snapshot) => {
        const stale = this.viewGeneration !== viewGen;
        this.adoptSnapshot(snapshot, stale);
        if (cueSessionId) {
          this.pendingCueSessions.delete(cueSessionId);
          // A committed cue consumes its draft only when the box is still
          // showing the session it belonged to. After a session switch the
          // text in the box belongs to the now-displayed session and is kept.
          const currentId = this.sessionRef?.id ?? null;
          if (currentId === cueSessionId) {
            this.patch({ cueDraft: '' });
          }
        }
      },
      (err) => {
        if (cueSessionId) this.pendingCueSessions.delete(cueSessionId);
        // A rejected command changes nothing server-side; keep the snapshot
        // AND the cue draft so the stage manager can correct and retry.
        //
        // The error answers only its own session and its own action: silence
        // it when a newer command superseded it, or when the displayed
        // session has since switched to a different one (e.g. a load of B).
        // A load of the SAME session does not take ownership, so a failure
        // that arrives after it is still surfaced and the draft retained.
        const superseded = this.commandGeneration !== cmdGen;
        const shownSessionId = this.sessionRef?.id ?? null;
        if (superseded || (targetSessionId !== null && shownSessionId !== targetSessionId)) {
          return;
        }
        this.patch({ error: toConsoleError(err) });
      },
    ).finally(() => {
      this.commandInFlight -= 1;
      if (this.commandInFlight === 0) this.patch({ commandBusy: false });
    });
  }

  create(): void {
    const name = this.state.nameDraft.trim();
    if (!name) {
      this.patch({ error: { code: 'INVALID_BODY', message: '请填写场次名称。' } });
      return;
    }
    // The plan is parsed from the draft exactly once, at the create
    // command. It then belongs to the session snapshot; later edits to the
    // same textarea only affect the *next* create.
    let planCues: number[] | undefined;
    let k: number | undefined;
    if (this.state.planEnabledDraft) {
      try {
        planCues = parseJsonInt32Array(this.state.planCuesDraft, '计划 cue 序列');
        k = parseK(this.state.planKDraft);
      } catch (err) {
        this.patch({ error: toConsoleError(err) });
        return;
      }
    }
    this.runCommand(
      () =>
        this.deps.submit({
          command: 'create',
          name,
          requestId: this.deps.newRequestId(),
          ...(planCues !== undefined && k !== undefined ? { planCues, k } : {}),
        }),
      null,
    );
  }

  load(): void {
    const id = this.state.loadIdDraft.trim();
    if (!id) {
      this.patch({ error: { code: 'INVALID_BODY', message: '请输入要载入的场次 ID。' } });
      return;
    }
    const loadGen = ++this.loadGeneration;
    const viewGen = ++this.viewGeneration;
    this.loadInFlight += 1;
    this.patch({ loadBusy: true, error: null });
    void this.deps.load(id).then(
      (snapshot) => {
        this.adoptSnapshot(snapshot, this.viewGeneration !== viewGen);
      },
      (err) => {
        if (this.loadGeneration !== loadGen) return;
        // A failed load (e.g. unknown id) must not wipe the session on screen.
        this.patch({ error: toConsoleError(err) });
      },
    ).finally(() => {
      this.loadInFlight -= 1;
      if (this.loadInFlight === 0) this.patch({ loadBusy: false });
    });
  }

  transition(status: PerformanceStatus): void {
    const session = this.state.session;
    if (!session) return;
    this.runCommand(
      () =>
        this.deps.submit({
          command: 'transition',
          performanceId: session.id,
          status,
          expectedVersion: session.version,
          requestId: this.deps.newRequestId(),
        }),
      session.id,
    );
  }

  registerCue(): void {
    const session = this.state.session;
    if (!session) return;
    let cue: number;
    try {
      cue = parseInt32(this.state.cueDraft);
    } catch (err) {
      this.patch({ error: toConsoleError(err) });
      return;
    }
    // NOTE: the draft is deliberately NOT cleared here. If the commit later
    // fails (or its answer arrives after a tab round-trip) the stage manager
    // must still see the cue and be able to retry; it is consumed only once
    // the owning session's committed snapshot arrives.
    this.runCommand(
      () =>
        this.deps.submit({
          command: 'registerCue',
          performanceId: session.id,
          cue,
          expectedVersion: session.version,
          requestId: this.deps.newRequestId(),
        }),
      session.id,
      session.id,
    );
  }
}

// ---------------------------------------------------------- deviation store

/** Identity of one comparison request: lets verdicts be told apart. */
export interface CheckIdentity {
  /** 1-based monotonically increasing number of the submission. */
  seq: number;
  /** FNV-1a hash of the exact submitted payload (a, b, k). */
  fingerprint: string;
  lengths: { a: number; b: number };
  k: number;
}

export type DeviationOutcome =
  | { kind: 'result'; value: DistanceResponse; identity: CheckIdentity }
  // Client-side validation never reaches the server and carries no identity.
  | { kind: 'error'; code: string; message: string; identity: CheckIdentity | null };

export interface DeviationState {
  planText: string;
  liveText: string;
  kText: string;
  busy: boolean;
  /** Identity of the latest request still in flight (null when settled). */
  pending: CheckIdentity | null;
  outcome: DeviationOutcome | null;
}

export interface DeviationDeps {
  compare: (a: unknown[], b: unknown[], k: number) => Promise<DistanceResponse>;
}

const defaultDeviationDeps: DeviationDeps = { compare: fetchDistance };

const SAMPLE_PLAN = '[101, 102, 103, 104, 105, 106, 107, 108]';
const SAMPLE_LIVE = '[101, 102, 104, 105, 205, 106, 107]';

export class DeviationStore extends Store<DeviationState> {
  private readonly deps: DeviationDeps;
  /** Submission sequence; each request keeps its own identity for its whole life. */
  private seq = 0;
  /** Sequence of the latest submission — older responses are discarded. */
  private latestSeq = 0;
  private inflightCount = 0;

  constructor(deps: DeviationDeps = defaultDeviationDeps) {
    super({
      planText: SAMPLE_PLAN,
      liveText: SAMPLE_LIVE,
      kText: '3',
      busy: false,
      pending: null,
      outcome: null,
    });
    this.deps = deps;
  }

  setPlanText(planText: string): void {
    this.patch({ planText });
  }

  setLiveText(liveText: string): void {
    this.patch({ liveText });
  }

  setKText(kText: string): void {
    this.patch({ kText });
  }

  compare(): void {
    let a: unknown[];
    let b: unknown[];
    let k: number;
    try {
      a = parseJsonArray(this.state.planText, '计划 cue 序列');
      b = parseJsonArray(this.state.liveText, '现场触发序列');
      k = parseK(this.state.kText);
    } catch (err) {
      // Never submitted: no request identity, inputs stay exactly as typed.
      const ce = toConsoleError(err);
      this.patch({ outcome: { kind: 'error', code: ce.code, message: ce.message, identity: null } });
      return;
    }

    const seq = (this.seq += 1);
    this.latestSeq = seq;
    const identity: CheckIdentity = {
      seq,
      fingerprint: fingerprint(JSON.stringify({ a, b, k })),
      lengths: { a: a.length, b: b.length },
      k,
    };
    this.inflightCount += 1;
    this.patch({ busy: true, pending: identity, outcome: null });

    void this.deps.compare(a, b, k).then(
      (value) => {
        // Superseded by a newer submission: its conclusion must never
        // overwrite the latest one, and it cannot clear the busy state of a
        // request still running.
        if (seq !== this.latestSeq) return;
        this.patch({ outcome: { kind: 'result', value, identity } });
      },
      (err) => {
        if (seq !== this.latestSeq) return;
        const ce = toConsoleError(err);
        this.patch({
          outcome: { kind: 'error', code: ce.code, message: ce.message, identity },
        });
      },
    ).finally(() => {
      this.inflightCount -= 1;
      // The overtaking response already published; the panel leaves busy
      // only once every request it sent has come home. An overtaken request
      // never publishes and never reaches this branch for the latest token.
      if (this.inflightCount === 0) {
        this.patch({ busy: false, pending: null });
      }
    });
  }
}
