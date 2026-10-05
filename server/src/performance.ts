/**
 * Performance session domain.
 *
 * A session (场次) is an event-sourced-looking aggregate kept in memory:
 *   id        - server assigned, stable for the life of the session
 *   name      - stage-manager supplied label
 *   status    - pending -> running <-> paused -> ended
 *   version   - optimistic-concurrency token, starts at 1, +1 per commit
 *   requestId   - id of the last command that was committed to the session
 *   cues        - ordered, currently-effective int32 cues
 *   corrections - audit trail of paused cue corrections; `cues` itself only
 *                 shows the replacement value that is in force
 *
 * Every command passes through two serialisation points:
 *
 *   1. a *request-id chain*, global across the whole service. A given
 *      requestId is adjudicated by at most one command at a time, so the
 *      "already committed?" check and the commit cannot interleave between
 *      two sessions (or between a create and a command on an existing
 *      session). This is what makes the deduplication promise global:
 *      one requestId maps to at most one successful commit for the entire
 *      life of the service, regardless of the target session.
 *
 *   2. the *session chain* (a CREATE chain plus one chain per session id),
 *      held for the duration of the request-id slot: validation,
 *      precondition checks and the state mutation happen in one
 *      synchronous critical section, so each command is either committed
 *      exactly once or rejected with the stored data and version
 *      untouched.
 *
 * Commands with different request ids never share a request-id slot, so
 * commands against different sessions still proceed in parallel; only the
 * per-session ordering (and equal-id contenders) are serialised.
 */

import { randomUUID } from 'node:crypto';
import { PrefixDistanceTracker, type DeviationSnapshot } from './prefix-distance.js';
import { ApiError } from './validation.js';

export const PERFORMANCE_STATUSES = ['pending', 'running', 'paused', 'ended'] as const;
export type PerformanceStatus = (typeof PERFORMANCE_STATUSES)[number];

/**
 * The planned cue sequence fixed at creation. Once a session exists this
 * never changes: page drafts edited afterwards can only feed a *new* create
 * command, never this plan.
 */
export interface PlannedCueSequence {
  cues: number[];
  k: number;
}

/** Serializable per-version deviation state (see prefix-distance.ts). */
export type DeviationState = DeviationSnapshot;

export interface Performance {
  id: string;
  name: string;
  status: PerformanceStatus;
  version: number;
  requestId: string | null;
  cues: number[];
  /**
   * Immutable audit entries for committed corrections. The effective timeline
   * remains `cues`; this list is the only place old values remain visible.
   */
  corrections: CueCorrectionRecord[];
  /** Null for sessions created without a plan — those keep the old flow. */
  plan: PlannedCueSequence | null;
  /** Null exactly when plan is null. */
  deviation: DeviationState | null;
}

export interface CueCorrectionRecord {
  /** One-based position in the effective timeline at correction time. */
  position: number;
  /** Value the stage manager asserted was previously at that position. */
  oldCue: number;
  /** Replacement value now effective at that position. */
  newCue: number;
  /** Version produced by the correction commit (old version + 1). */
  version: number;
}

/** The live aggregate: the mutable frontier tracker never leaves the store. */
interface Session extends Performance {
  tracker: PrefixDistanceTracker | null;
}

export interface CreateCommand {
  type: 'create';
  name: string;
  requestId: string;
  /** Null creates a legacy session with no deviation tracking. */
  plan: PlannedCueSequence | null;
}

export interface TransitionCommand {
  type: 'transition';
  performanceId: string;
  status: PerformanceStatus;
  expectedVersion: number;
  requestId: string;
}

export interface RegisterCueCommand {
  type: 'registerCue';
  performanceId: string;
  cue: number;
  expectedVersion: number;
  requestId: string;
}

export interface CorrectCueCommand {
  type: 'correctCue';
  performanceId: string;
  position: number;
  oldCue: number;
  newCue: number;
  expectedVersion: number;
  requestId: string;
}

export type PerformanceCommand =
  | CreateCommand
  | TransitionCommand
  | RegisterCueCommand
  | CorrectCueCommand;

/** Rejection reasons surfaced alongside code COMMAND_REJECTED. */
export type RejectReason =
  | 'DUPLICATE_REQUEST'
  | 'VERSION_CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_RUNNING'
  | 'NOT_PAUSED'
  | 'INVALID_POSITION'
  | 'OLD_CUE_MISMATCH'
  | 'REBUILD_FAILED';

// Legal status advance table. pending -> running, running <-> paused,
// running/paused -> ended (no resume required to seal). ended is terminal.
const LEGAL_TRANSITIONS: Record<PerformanceStatus, readonly PerformanceStatus[]> = {
  pending: ['running'],
  running: ['paused', 'ended'],
  paused: ['running', 'ended'],
  ended: [],
};

const CREATE_CHAIN_KEY = '__create__';

function reject(reason: RejectReason, message: string): never {
  throw new ApiError('COMMAND_REJECTED', message, 409, reason);
}

/**
 * Reject a replay of an already-committed request id. The message always
 * names the session the id *first* committed to (its stable global owner),
 * never the session the replay happened to target, so audit logs and
 * client retries see the same conclusion from every target.
 */
function rejectDuplicate(requestId: string, ownerId: string): never {
  reject(
    'DUPLICATE_REQUEST',
    `Request id "${requestId}" was already committed to session "${ownerId}".`,
  );
}

export class PerformanceStore {
  private readonly sessions = new Map<string, Session>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Serial chain per requestId: one adjudication per id at a time, globally. */
  private readonly requestChains = new Map<string, Promise<unknown>>();
  // requestId of every *committed* command -> id of the session it first
  // committed to. Global, so a duplicate is detected no matter which
  // session (or create) it is replayed against afterwards.
  private readonly committedRequests = new Map<string, string>();

  /** Run `task` serially at the end of the chain keyed by `key`. */
  private async runExclusive<T>(
    chains: Map<string, Promise<unknown>>,
    key: string,
    task: () => T | Promise<T>,
  ): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = previous.then(() => gate);
    chains.set(key, slot);
    try {
      await previous;
    } catch {
      // A prior task's rejection is delivered to its own caller.
    }
    try {
      return await task();
    } finally {
      release();
      // Remove the chain only if nobody queued behind us; otherwise the
      // last waiter performs the cleanup.
      if (chains.get(key) === slot) chains.delete(key);
    }
  }

  get(id: string): Performance {
    const session = this.sessions.get(id);
    if (!session) {
      throw new ApiError(
        'SESSION_NOT_FOUND',
        `No performance session exists with id "${id}".`,
        404,
      );
    }
    return this.snapshot(session);
  }

  dispatch(command: PerformanceCommand): Promise<Performance> {
    // The global request-id slot wraps the per-session adjudication. Two
    // commands sharing an id cannot run their decide() sections at the
    // same time, so a cross-session loser always observes the winner's
    // committed id; the loser never touches any session.
    return this.runExclusive(this.requestChains, command.requestId, async () => {
      // Fast path: the id may have committed long before this request
      // arrived; reject without even entering the session chain.
      const owner = this.committedRequests.get(command.requestId);
      if (owner !== undefined) rejectDuplicate(command.requestId, owner);
      const key = command.type === 'create' ? CREATE_CHAIN_KEY : command.performanceId;
      return await this.runExclusive(this.chains, key, () => this.decide(command));
    });
  }

  /**
   * The decision procedure. Runs inside the request-id slot and the
   * per-session chain, so the whole read-check-write sequence is one
   * atomic step. All throws leave the store untouched (nothing is mutated
   * before the single commit at the end).
   */
  private decide(command: PerformanceCommand): Performance {
    // Rechecked inside every lock: an earlier contender (e.g. one queued
    // on the same session chain for another reason) may have committed the
    // id in the meantime. This check deliberately precedes the session
    // lookup, so replaying a committed id at a missing session reports the
    // duplicate instead of SESSION_NOT_FOUND, exactly like replaying it at
    // any existing foreign session.
    const ownerId = this.committedRequests.get(command.requestId);
    if (ownerId !== undefined) {
      rejectDuplicate(command.requestId, ownerId);
    }

    if (command.type === 'create') {
      // The plan is frozen into the aggregate here and never copied out of
      // a later request: page-draft changes after creation cannot reach it.
      const tracker = command.plan ? new PrefixDistanceTracker(command.plan.cues, command.plan.k) : null;
      const session: Session = {
        id: randomUUID(),
        name: command.name,
        status: 'pending',
        version: 1,
        requestId: command.requestId,
        cues: [],
        corrections: [],
        plan: command.plan ? { cues: [...command.plan.cues], k: command.plan.k } : null,
        deviation: tracker ? tracker.snapshot() : null,
        tracker,
      };
      this.sessions.set(session.id, session);
      // Single commit point for creates: the new session and the global
      // id record appear together.
      this.committedRequests.set(command.requestId, session.id);
      return this.snapshot(session);
    }

    const session = this.sessions.get(command.performanceId);
    if (!session) {
      throw new ApiError(
        'SESSION_NOT_FOUND',
        `No performance session exists with id "${command.performanceId}".`,
        404,
      );
    }

    // Only *committed* request ids count as duplicates. A rejected command
    // leaves the store untouched, so its request id is never recorded: the
    // caller may correct the precondition (version/transition/run-state)
    // and replay the very same request id without being falsely reported as
    // a duplicate. Recording happens exclusively at the commit point below.

    if (command.expectedVersion !== session.version) {
      reject(
        'VERSION_CONFLICT',
        `expectedVersion ${command.expectedVersion} does not match current version ${session.version}.`,
      );
    }

    if (command.type === 'transition') {
      if (!LEGAL_TRANSITIONS[session.status].includes(command.status)) {
        reject(
          'ILLEGAL_TRANSITION',
          `Cannot move session from "${session.status}" to "${command.status}".`,
        );
      }
      session.status = command.status;
      // Sealing compares the whole live sequence with the *whole* fixed
      // plan; a rejected transition (above) throws before reaching here, so
      // the verdict is produced exactly once and never rolls back.
      if (command.status === 'ended' && session.tracker) {
        session.tracker.finalize();
      }
    } else if (command.type === 'registerCue') {
      if (session.status !== 'running') {
        reject(
          'NOT_RUNNING',
          `Cues can only be registered while running; session is "${session.status}".`,
        );
      }
      session.cues.push(command.cue);
      // Exactly one frontier step per accepted cue — rejected commands
      // throw above and never advance the distance state.
      session.tracker?.append(command.cue);
    } else {
      if (session.status !== 'paused') {
        reject(
          'NOT_PAUSED',
          `Registered cues can only be corrected while paused; session is "${session.status}".`,
        );
      }

      const index = command.position - 1;
      if (!Number.isInteger(index) || index < 0 || index >= session.cues.length) {
        reject(
          'INVALID_POSITION',
          `Cue position ${command.position} does not exist in the current timeline (length ${session.cues.length}).`,
        );
      }
      if (session.cues[index] !== command.oldCue) {
        reject(
          'OLD_CUE_MISMATCH',
          `Cue at position ${command.position} is ${session.cues[index]}, not ${command.oldCue}.`,
        );
      }

      // Build the complete candidate timeline first. A correction can make
      // the previously monotone frontier recoverable again, so it is not safe
      // to mutate or reuse the old tracker: replay the fixed plan against the
      // candidate from row zero. No existing aggregate field is touched until
      // this rebuild has completed.
      const nextCues = [...session.cues];
      nextCues[index] = command.newCue;
      let nextTracker: PrefixDistanceTracker | null = null;
      let nextDeviation: DeviationState | null = null;
      if (session.plan) {
        try {
          nextTracker = new PrefixDistanceTracker(session.plan.cues, session.plan.k);
          for (const cue of nextCues) nextTracker.append(cue);
          nextDeviation = nextTracker.snapshot();
        } catch (err) {
          // The candidate and the stored aggregate are both still intact at
          // this point. Surface the rebuild failure as an adjudication error
          // rather than committing any half-built state.
          throw new ApiError(
            'COMMAND_REJECTED',
            `Failed to rebuild deviation state from the corrected timeline: ${(err as Error).message}`,
            409,
            'REBUILD_FAILED',
          );
        }
      }

      const nextVersion = session.version + 1;
      session.cues = nextCues;
      session.tracker = nextTracker;
      session.deviation = nextDeviation;
      session.corrections.push({
        position: command.position,
        oldCue: command.oldCue,
        newCue: command.newCue,
        version: nextVersion,
      });
    }

    // Single commit point: version bump and request-id recording happen
    // together with the state change.
    session.version += 1;
    session.requestId = command.requestId;
    this.committedRequests.set(command.requestId, session.id);
    if (session.tracker) session.deviation = session.tracker.snapshot();
    return this.snapshot(session);
  }

  private snapshot(session: Session): Performance {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      version: session.version,
      requestId: session.requestId,
      cues: [...session.cues],
      corrections: session.corrections.map((correction) => ({ ...correction })),
      plan: session.plan ? { cues: [...session.plan.cues], k: session.plan.k } : null,
      deviation: session.deviation ? { ...session.deviation, final: session.deviation.final ? { ...session.deviation.final } : null } : null,
    };
  }
}
