// ─── LabeledExecutor ───
// The safe wiring for a per-action signingLabel: a one-shot pending-label slot
// (set by execute(), consumed once by resolve(), cleared in a finally) plus
// serialization, so labeled execute() calls can never cross-label each other's
// signature. Hand-rolling that slot is prone to stale labels (a failed attempt leaves
// its label pending for the next one) and to cross-labels (two overlapping calls
// racing to set it).
//
// The slot has no public setter and is an ECMAScript private field, so the only way to
// label a signature is execute().
//
// WIRED-INSTANCE INVARIANT: every execute() on the wired account must go through this
// instance. ENFORCED while the executor is idle: resolve() throws if called with no
// execute() in flight, so a bypassing account.execute() call fails at sign time instead
// of silently signing under a wrong or default label. A bypass that overlaps an in-flight
// execute() remains undetectable (label correlation without the hash is impossible) and
// stays a documented requirement, not a checked one.
//
// execute() is not reentrant: calling it from within a running execute() on the same
// instance deadlocks, because the inner call waits on a queue tail the outer call holds.
// There is no timeout: a wallet popup that never settles blocks every later labeled
// execute() on this instance.
// A dropped execute() promise has its rejection consumed by the queue (nothing is
// reported as unhandled), so callers must await it to observe a failure.

import type { Call } from "starknet";

/** Minimal execute() capability; matches any AccountInterface-shaped object. */
interface Executable<T> {
  execute(calls: Call[]): Promise<T>;
}

export class LabeledExecutor {
  /** Private as an ECMAScript hash field, not TS `private`: the es2021 build erases
   *  `private`, leaving a plain property whose absence (nothing pending) would fall
   *  through to a polluted `Object.prototype.pending`. */
  #pending: string | undefined;
  /** True only while an execute() call is awaiting account.execute(). A boolean
   *  suffices, not a counter: the queue serializes execute() calls into non-overlapping
   *  windows, so at most one is ever in flight on this instance. */
  #inFlight = false;
  /** Tail of the serialization chain; always settled (rejections are swallowed here,
   *  never on the promise returned to callers), so one failed execute() never wedges
   *  a later one. */
  #queue: Promise<void> = Promise.resolve();
  #defaultLabel: string | undefined;

  constructor(defaultLabel?: string) {
    this.#defaultLabel = defaultLabel;
  }

  /** Consumed by the SDK at sign time: pending (clearing it) else the default.
   *  SDK-internal: the signer calls this. App code labels a signature through
   *  execute(), never by calling this directly. Throws if no execute() is in flight:
   *  a signature was requested on the wired account outside LabeledExecutor.execute(),
   *  which every execute on this account must go through. */
  resolve(): string | undefined {
    if (!this.#inFlight) {
      throw new Error(
        "LabeledExecutor.resolve: signature requested on the wired account outside " +
          "LabeledExecutor.execute(). Every execute on this account must go through " +
          "the executor.",
      );
    }
    if (this.#pending === undefined) return this.#defaultLabel;
    const label = this.#pending;
    this.#pending = undefined;
    return label;
  }

  /** The safe path: set label -> await account.execute(calls) -> finally clear.
   *  Omitting `label` signs with the constructor's default; passing `''` signs the bare
   *  hash, overriding that default. Serialized: concurrent calls run strictly one at a
   *  time so a label can never attach to another call's signature. The queue survives
   *  rejections (chained on catch); the caller still receives the original rejection. */
  execute<T>(account: Executable<T>, calls: Call[], label?: string): Promise<T> {
    const run = this.#queue.then(async () => {
      this.#pending = label;
      this.#inFlight = true;
      try {
        return await account.execute(calls);
      } finally {
        this.#pending = undefined;
        this.#inFlight = false;
      }
    });
    // The queue advances regardless of run's outcome; the rejection itself is only
    // ever observed through `run`, the promise returned to this caller.
    this.#queue = run.then(
      () => undefined, // success: drop the result, the queue signals settlement only
      () => undefined, // failure: swallow so a rejected run cannot wedge the queue
    );
    return run;
  }
}
