/**
 * Concurrency limiters for the status/snapshot write path — FIX-1121, FIX-1126.
 *
 * WHY THESE EXIST AT ALL
 *
 * computeStatusPayload's cost is not its queries, it is the contention between
 * them. Measured on prod 2026-08-29: `SELECT count(*) FROM votes` is 261 ms via
 * psql and 555 ms through PostgREST, and a faithful replay of getDatabase's
 * whole 11-way fan-out from *outside* the lambda finished in 559 ms — while the
 * same section inside the payload took 8266–9165 ms and tripped the
 * authenticator role's 8 s statement_timeout. Bounding the fan-out is therefore
 * the lever; making the individual queries faster is not.
 *
 * WHY THIS FILE AND NOT _lib/status-snapshot.ts
 *
 * mapWithConcurrency lived in status-snapshot.ts (FIX-1121). FIX-1126 needed the
 * same bound one level down, inside sections.ts — and sections.ts is what
 * status-snapshot.ts imports, so pulling the limiter back up the graph would be
 * a cycle. Both primitives live here beside section-failures.ts instead: no
 * imports, one module owning the pattern, one test file.
 *
 * TWO SHAPES, DELIBERATELY
 *
 * They are not interchangeable and neither subsumes the other:
 *   - mapWithConcurrency — a homogeneous list of tasks, results positional.
 *   - concurrencyGate — heterogeneous call sites that each keep their own type,
 *     wrapped in place. getDatabase destructures eleven differently-typed
 *     Postgrest responses; routing those through a map collapses them to a
 *     union (and to `T | undefined` under noUncheckedIndexedAccess), which
 *     would push a fake nullability onto every reader downstream.
 */

/**
 * Minimal ordered concurrency limiter — no new dependency. Results come back
 * positionally, so the caller can keep mapping tasks to payload keys by index.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      results[i] = await fn(item, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

/**
 * A semaphore as a wrapper function: `gate(() => work())` runs `work` when a
 * permit is free and resolves to its value, preserving the value's exact type.
 * Use it to bound an existing `Promise.all([...])` without disturbing the
 * tuple typing or the destructuring order at the call site.
 *
 * The permit is handed off directly on release rather than decremented and
 * re-acquired. That ordering is load-bearing: waiters resume on a microtask, so
 * a decrement-then-wake would leave the slot briefly claimable by a caller that
 * arrives synchronously in between, and the pool would overcommit by one.
 *
 * A thrown task releases its permit (finally), so one failure cannot wedge the
 * queue — which is what the callers need, since Postgrest errors arrive as
 * resolved `{error}` values but a network fault does throw.
 */
export function concurrencyGate(limit: number) {
  const max = Math.max(1, Math.floor(limit));
  let held = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (held < max) {
      held++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  };

  const release = () => {
    const next = waiting.shift();
    // Hand the permit straight to the next waiter — `held` stays put.
    if (next) next();
    else held--;
  };

  return async function gate<R>(task: () => PromiseLike<R>): Promise<R> {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
