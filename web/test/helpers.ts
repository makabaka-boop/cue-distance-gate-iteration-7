import type { DistanceResponse, Performance } from '../src/api';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush .then/.finally continuations (promise jobs + a microtask edge). */
export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function perf(over: Partial<Performance> & { id: string }): Performance {
  return {
    name: over.name ?? '晚场',
    status: over.status ?? 'running',
    version: over.version ?? 1,
    requestId: over.requestId ?? null,
    cues: over.cues ?? [],
    plan: over.plan ?? null,
    deviation: over.deviation ?? null,
    ...over,
  };
}

let rid = 0;
export function reqId(): string {
  rid += 1;
  return `rid-${rid}`;
}

/** Collect every submission/load call and queue its controllable promise. */
export interface PendingCall<T> extends Deferred<T> {
  payload: unknown;
}

export function controlledConsoleDeps() {
  const commands: PendingCall<Performance>[] = [];
  const loads: PendingCall<Performance>[] = [];
  return {
    commands,
    loads,
    deps: {
      submit: (payload: unknown) => {
        const d = deferred<Performance>() as PendingCall<Performance>;
        d.payload = payload;
        commands.push(d);
        return d.promise;
      },
      load: (id: string) => {
        const d = deferred<Performance>() as PendingCall<Performance>;
        d.payload = id;
        loads.push(d);
        return d.promise;
      },
      newRequestId: reqId,
    },
  };
}

export function controlledDeviationDeps() {
  const calls: PendingCall<DistanceResponse>[] = [];
  return {
    calls,
    deps: {
      compare: () => {
        const d = deferred<DistanceResponse>() as PendingCall<DistanceResponse>;
        calls.push(d);
        return d.promise;
      },
    },
  };
}

export function distance(distance: number | 'exceeded', k: number, a: number, b: number) {
  const lengths = { a, b };
  return distance === 'exceeded'
    ? ({ status: 'exceeded', k, lengths } as DistanceResponse)
    : ({ status: 'ok', distance, k, lengths } as DistanceResponse);
}

/** Mimic the wire ApiError for rejected responses. */
export class FakeApiError extends Error {
  readonly code: string;
  readonly reason?: string;
  readonly status: number;
  constructor(code: string, reason: string | undefined, status = 409) {
    super(`server: ${code} ${reason ?? ''}`.trim());
    this.code = code;
    this.reason = reason;
    this.status = status;
  }
}
