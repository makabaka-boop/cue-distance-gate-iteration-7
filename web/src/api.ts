export interface SequenceLengths {
  a: number;
  b: number;
}

export interface DistanceOk {
  status: 'ok';
  distance: number;
  k: number;
  lengths: SequenceLengths;
}

export interface DistanceExceeded {
  status: 'exceeded';
  k: number;
  lengths: SequenceLengths;
}

export type DistanceResponse = DistanceOk | DistanceExceeded;

// ------------------------------------------------------------- performances

export type PerformanceStatus = 'pending' | 'running' | 'paused' | 'ended';

/** Fixed plan sealed at creation (null on legacy sessions without a plan). */
export interface PlannedCueSequence {
  cues: number[];
  k: number;
}

export interface DeviationFinal {
  status: 'ok' | 'exceeded';
  /** Present only with status 'ok': the exact whole-sequence distance. */
  distance?: number;
}

/**
 * Per-version deviation state. `boundary` = min over planned prefixes of the
 * distance from the whole live prefix heard so far, capped at k + 1.
 * `recoverable` (boundary <= k) answers "still salvageable"; `final` only
 * appears once the session has ended and was compared with the whole plan.
 */
export interface DeviationState {
  k: number;
  plannedLength: number;
  liveLength: number;
  boundary: number;
  recoverable: boolean;
  final: DeviationFinal | null;
}

export interface Performance {
  id: string;
  name: string;
  status: PerformanceStatus;
  version: number;
  requestId: string | null;
  cues: number[];
  plan: PlannedCueSequence | null;
  deviation: DeviationState | null;
}

export type PerformanceCommand =
  | {
      command: 'create';
      name: string;
      requestId: string;
      planCues?: number[];
      k?: number;
    }
  | {
      command: 'transition';
      performanceId: string;
      status: PerformanceStatus;
      expectedVersion: number;
      requestId: string;
    }
  | {
      command: 'registerCue';
      performanceId: string;
      cue: number;
      expectedVersion: number;
      requestId: string;
    };

export interface ApiErrorBody {
  error: { code: string; message: string; reason?: string };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reason?: string;

  constructor(body: ApiErrorBody, status: number) {
    super(body.error.message);
    this.name = 'ApiError';
    this.code = body.error.code;
    this.reason = body.error.reason;
    this.status = status;
  }
}

async function postJson(path: string, payload: unknown): Promise<any> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new ApiError(body as ApiErrorBody, res.status);
  }
  return body;
}

export async function fetchDistance(
  a: unknown[],
  b: unknown[],
  k: number,
): Promise<DistanceResponse> {
  const body = await postJson('/api/distance', { a, b, k });
  return body as DistanceResponse;
}

/**
 * Performance console — the only write entry. Every command carries an
 * expectedVersion (optimistic concurrency) and a freshly generated requestId
 * (duplicate detection); the response is the committed session snapshot.
 */
export async function submitPerformanceCommand(
  command: PerformanceCommand,
): Promise<Performance> {
  const body = await postJson('/api/performances/commands', command);
  return body.performance as Performance;
}

/** Performance console — the only read entry: load a snapshot by id. */
export async function loadPerformance(id: string): Promise<Performance> {
  const res = await fetch(`/api/performances/${encodeURIComponent(id)}`);
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new ApiError(body as ApiErrorBody, res.status);
  }
  return (body as { performance: Performance }).performance;
}

/** Generate a fresh client-side request id for one command submission. */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
