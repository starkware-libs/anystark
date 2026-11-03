import { describe, expect, it } from "vitest";
import type { Call } from "starknet";
import { LabeledExecutor } from "./labeled_executor";

const CALLS: Call[] = [{ contractAddress: "0x1", entrypoint: "transfer", calldata: [] }];

/** Resolve after `ms`, so two overlapping execute() calls can be made to settle in
 *  either order regardless of submission order. */
function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise((res) => setTimeout(() => res(value), ms));
}

describe("LabeledExecutor.resolve (no execute() in flight)", () => {
  it("throws on a defaulted executor", () => {
    const labeledExecutor = new LabeledExecutor("default");
    expect(() => labeledExecutor.resolve()).toThrow(/outside LabeledExecutor\.execute\(\)/);
  });

  it("throws on a default-constructed executor", () => {
    const labeledExecutor = new LabeledExecutor();
    expect(() => labeledExecutor.resolve()).toThrow(/outside LabeledExecutor\.execute\(\)/);
  });
});

describe("LabeledExecutor.execute", () => {
  it("consumes the label at sign time and clears it after success", async () => {
    const labeledExecutor = new LabeledExecutor("default");
    let capturedDuringExecute: string | undefined;
    const account = {
      execute: async (calls: Call[]) => {
        // Mirrors the SDK: resolve() is called mid-flight, from inside account.execute().
        capturedDuringExecute = labeledExecutor.resolve();
        return calls.length;
      },
    };
    const result = await labeledExecutor.execute(account, CALLS, "buy 1 STRK");
    expect(capturedDuringExecute).toBe("buy 1 STRK");
    expect(result).toBe(1);
    // Consumed, not leaked: a later execute() (in flight, so resolve() doesn't throw)
    // falls back to the default rather than replaying "buy 1 STRK".
    let capturedNext: string | undefined;
    await labeledExecutor.execute(
      {
        execute: async () => {
          capturedNext = labeledExecutor.resolve();
        },
      },
      CALLS,
    );
    expect(capturedNext).toBe("default");
  });

  it("omitted label signs with the constructor's default", async () => {
    const labeledExecutor = new LabeledExecutor("default");
    let captured: string | undefined;
    const account = {
      execute: async () => {
        captured = labeledExecutor.resolve();
      },
    };
    await labeledExecutor.execute(account, CALLS);
    expect(captured).toBe("default");
  });

  it("an explicit '' label overrides the default and signs the bare hash", async () => {
    const labeledExecutor = new LabeledExecutor("default");
    let captured: string | undefined;
    const account = {
      execute: async () => {
        captured = labeledExecutor.resolve();
      },
    };
    // '' is a pending value, not an absent one: only an OMITTED label falls back.
    await labeledExecutor.execute(account, CALLS, "");
    expect(captured).toBe("");
  });

  it("omitted label with no default signs the bare hash", async () => {
    const labeledExecutor = new LabeledExecutor();
    let captured: string | undefined;
    const account = {
      execute: async () => {
        captured = labeledExecutor.resolve();
      },
    };
    await labeledExecutor.execute(account, CALLS);
    expect(captured).toBeUndefined();
  });

  it("clears the label in finally on a throw, so the next resolve gets the default", async () => {
    const labeledExecutor = new LabeledExecutor("default");
    const account = {
      execute: async () => {
        throw new Error("execute failed");
      },
    };
    await expect(labeledExecutor.execute(account, CALLS, "buy 1 STRK")).rejects.toThrow(
      "execute failed",
    );
    // A later execute() (in flight, so resolve() doesn't throw) gets the default, not
    // the failed attempt's stale label.
    let captured: string | undefined;
    await labeledExecutor.execute(
      {
        execute: async () => {
          captured = labeledExecutor.resolve();
        },
      },
      CALLS,
    );
    expect(captured).toBe("default");
  });

  it("propagates the original rejection to the caller", async () => {
    const labeledExecutor = new LabeledExecutor();
    const account = {
      execute: async () => {
        throw new Error("boom");
      },
    };
    await expect(labeledExecutor.execute(account, CALLS, "x")).rejects.toThrow("boom");
  });
});

describe("LabeledExecutor serialization", () => {
  it("runs concurrent execute() calls one at a time, each labeled with its own call", async () => {
    const labeledExecutor = new LabeledExecutor();
    const captured: string[] = [];
    let started = 0;
    const account = {
      execute: async () => {
        // The first call is the slow one (20ms vs 5ms), and each resolves AFTER its
        // await: unserialized, the second execute() would overwrite the pending label
        // before the first one reads it, so the first would capture "second" or the
        // absent-label fallback.
        await delayed(undefined, ++started === 1 ? 20 : 5);
        captured.push(labeledExecutor.resolve() ?? "<none>");
        return undefined;
      },
    };
    const first = labeledExecutor.execute(account, CALLS, "first");
    const second = labeledExecutor.execute(account, CALLS, "second");
    await Promise.all([first, second]);
    expect(captured).toEqual(["first", "second"]);
  });

  it("does not start the second execute() before the first settles", async () => {
    const labeledExecutor = new LabeledExecutor();
    const order: string[] = [];
    const account = {
      execute: async () => {
        order.push("start");
        await delayed(undefined, 10);
        order.push("end");
      },
    };
    const first = labeledExecutor.execute(account, CALLS, "a");
    const second = labeledExecutor.execute(account, CALLS, "b");
    await Promise.all([first, second]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });

  it("the queue survives a rejection: a later execute() still runs after an earlier one throws", async () => {
    const labeledExecutor = new LabeledExecutor();
    const captured: string[] = [];
    const failing = {
      execute: async () => {
        throw new Error("first failed");
      },
    };
    const succeeding = {
      execute: async () => {
        captured.push(labeledExecutor.resolve() ?? "");
        return "ok";
      },
    };
    const first = labeledExecutor.execute(failing, CALLS, "a");
    const second = labeledExecutor.execute(succeeding, CALLS, "b");
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("ok");
    expect(captured).toEqual(["b"]);
  });
});

describe("LabeledExecutor label state", () => {
  it("is unreachable through Object.prototype pollution", async () => {
    // TS `private` is erased by the es2021 build, and an unset property falls through
    // to the prototype chain: a polluted `pending` would label a signature the app
    // never labeled. Hash-private fields are looked up on the instance alone.
    const polluted = Object.prototype as unknown as { pending?: string; defaultLabel?: string };
    polluted.pending = "attacker: transfer 1000 USDC to 0xbad";
    polluted.defaultLabel = "attacker: approve unlimited USDC";
    try {
      const labeledExecutor = new LabeledExecutor();
      // A polluted `inFlight` would also defeat the invariant check; it doesn't, so
      // resolve() still throws with nothing in flight.
      expect(() => labeledExecutor.resolve()).toThrow(/outside LabeledExecutor\.execute\(\)/);
      let captured: string | undefined = "unset";
      const account = {
        execute: async () => {
          captured = labeledExecutor.resolve();
        },
      };
      await labeledExecutor.execute(account, CALLS);
      expect(captured).toBeUndefined();
    } finally {
      delete polluted.pending;
      delete polluted.defaultLabel;
    }
  });
});
