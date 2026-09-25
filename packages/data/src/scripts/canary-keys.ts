/**
 * FIX-1197 — the census of `canary-check.ts`'s condition keys.
 *
 * WHY. cc-133 §7(a) went looking for the place a new canary condition key gets
 * registered and found there is none. `detector-coverage.test.ts` is DB-backed,
 * self-skipping, and about the FIX-977 registry ⊇ census property; it carries
 * no key list and cannot go red for an unregistered key. The only registration
 * anywhere was a three-line stability assertion in `canary-prod-session.test.ts`
 * pinning the VALUE of three keys somebody had already thought to write down.
 * So FIX-1190's `prod_session_hold_stale` never went red before it was added,
 * because nothing in the tree could make it.
 *
 * A condition key is the identity the FIX-1036 transition classifier keys on:
 * `new` / `worse` / `recovered` are all computed by comparing this run's key set
 * against the last one. A key that changes spelling reads as one condition
 * recovering and a different one appearing — so the set is an interface, and an
 * interface with no census drifts silently.
 *
 * THE KEYS ARE IMPORTED, NEVER RE-TYPED. Every static key that already has a
 * named constant is re-exported from where it is defined. A registry that
 * spells `"prod_session_overrun"` by hand is a second source of truth and
 * passes its own test while disagreeing with the shipped detector.
 *
 * The companion test SOURCE-SCANS `canary-check.ts` for every `push(` argument
 * and asserts the two sets agree in both directions. Adding a key without
 * adding it here fails; leaving a key here after deleting it fails too.
 */

import { KEY_DISPATCH_REFUSED, KEY_DISPATCH_STALE } from "./canary-gha-dispatch";
import { KEY_FRONT_DOOR_BLIND } from "./canary-front-door";
import { KEY_BLIND, KEY_MISSING, KEY_UNCOLLECTED } from "./canary-fec-drop";
import { KEY_HOLD_STALE, KEY_LABEL_STALE, KEY_OVERRUN } from "./canary-prod-session";
import { KEY_MEM_STALE, KEY_PROBE_STALE } from "./canary-box-health";

/**
 * Every condition key with a FIXED spelling, as `canary-check.ts` pushes it.
 *
 * The comments say what the key means, not where it lives — the test finds the
 * call sites by scan, so a line number here would be a third thing to keep in
 * step and the first to go stale.
 */
export const CONDITION_KEYS: readonly string[] = [
  "nightly_missing", //    nightly_cron missed N days
  "nightly_killed", //     nightly_cron killed by the workflow timeout
  "cron_startup_burst", // N hourly buckets at/above the burst threshold
  "canary_silent", //      canary_check itself stopped running
  "sector_affinity", //    rollup stranded on a tag change
  KEY_DISPATCH_REFUSED, // gha_dispatch_refused     (FIX-1218, report-only)
  KEY_DISPATCH_STALE, //   gha_dispatch_stale       (FIX-1218, report-only)
  KEY_FRONT_DOOR_BLIND, // front_door_corroborator_unavailable (FIX-1219, report-only)
  KEY_OVERRUN, //          prod_session_overrun
  KEY_LABEL_STALE, //      prod_session_label_stale
  KEY_HOLD_STALE, //       prod_session_hold_stale   (FIX-1177/1172)
  KEY_UNCOLLECTED, //      fec_drop_uncollected      \
  KEY_BLIND, //            fec_drop_probe_blind       > one key per STATE, so a
  KEY_MISSING, //          fec_drop_probe_missing    /  probe outage cannot read
  //                                                    as a recovery from an
  //                                                    uncollected drop
  KEY_PROBE_STALE, //      box_health_probe_stale    (FIX-1194 P1-B, report-only)
  KEY_MEM_STALE, //        box_health_mem_stale      (FIX-1125, report-only)
];

/**
 * Every key FAMILY with a dynamic suffix, as its prefix.
 *
 * The suffix is the thing the condition is ABOUT — a table name, a pipeline, a
 * jobid — so the key stays stable across runs for the same underlying problem,
 * which is what makes `new` and `recovered` mean anything.
 *
 * `cron_startup_burst` is deliberately NOT here. Its natural suffix would be the
 * hourly bucket timestamp, which changes every run by construction, so keying on
 * it would make every burst permanently `new` and page nightly — the exact
 * defect FIX-1036 fixed. It is a flat key in CONDITION_KEYS instead, and that
 * asymmetry is the one thing here worth re-reading before adding a key.
 */
export const CONDITION_KEY_PREFIXES: readonly string[] = [
  "autovacuum_stranded:", // suffix: table name
  "vm_degraded:", //         suffix: table name
  "rollup:", //              suffix: pipeline
  "orphan:", //              suffix: pipeline
  "cron_startup_streak:", // suffix: jobid
  "cron_startup_legacy:", // suffix: jobid
  "cron_missing_daily:", //  suffix: jobid
  "rate_regression:", //     suffix: pipeline
];

/** The `const push = (...)` definition. Everything above it is a different push. */
export const PUSH_DEFINITION = "const push = (key: string,";

/** One key the scan found, with how it was spelled at the call site. */
export interface PushedKey {
  kind: "literal" | "prefix" | "constant" | "unresolved";
  /** The key (literal), the prefix (prefix), or the identifier name otherwise. */
  value: string;
  /** Character offset of the `push(` in the source, for a useful failure. */
  at: number;
}

const KEY_CONST = /\bKEY_[A-Z0-9_]+\b/g;

/**
 * Extract every condition key or prefix `canary-check.ts` can emit.
 *
 * Reads SOURCE rather than importing, because the keys are not a list anywhere
 * in the running program — they are first arguments at twenty-odd call sites, in
 * four shapes: a string literal, a template with a dynamic suffix, an imported
 * `KEY_*` constant (sometimes inside a ternary), and one LOCAL `key` assigned
 * from a three-way state ternary above the call. Only a text scan sees all four.
 *
 * Two things the scan has to get right or it measures nothing:
 *
 *   - It anchors AFTER the `const push =` definition. `canary-check.ts` calls
 *     `Array.prototype.push` about forty times above it, and a scan from the top
 *     collects `parts`, `sections` and `failures` instead of conditions.
 *   - It matches `push(` only when NOT preceded by a dot, so the definition's own
 *     `conditions.push({ key, ... })` body line is excluded.
 *
 * An argument it cannot resolve comes back `unresolved` rather than being
 * dropped. A scan that silently skips what it does not understand is a scan that
 * passes by understanding nothing.
 */
export function extractPushedKeys(src: string): PushedKey[] {
  const at = src.indexOf(PUSH_DEFINITION);
  if (at < 0) {
    throw new Error(
      `extractPushedKeys: '${PUSH_DEFINITION}' not found. The scan anchors on it because ` +
        `canary-check.ts also calls Array.prototype.push ~40 times above it, and a scan ` +
        `that starts at the top collects those instead.`,
    );
  }
  const head = at + PUSH_DEFINITION.length;
  const body = src.slice(head);
  const out: PushedKey[] = [];

  for (const m of body.matchAll(/(?<![.\w$])push\(\s*([^,]+?)\s*,/g)) {
    const arg = m[1]!.trim();
    const idx = m.index ?? 0;
    const off = head + idx;

    if (/^"[^"]*"$/.test(arg)) {
      out.push({ kind: "literal", value: arg.slice(1, -1), at: off });
      continue;
    }
    if (arg.startsWith("`")) {
      const i = arg.indexOf("${");
      out.push({ kind: "prefix", value: arg.slice(1, i < 0 ? arg.length - 1 : i), at: off });
      continue;
    }

    // `KEY_*` constants wherever they sit in the expression — a bare
    // `KEY_HOLD_STALE`, or `x === "overrun" ? KEY_OVERRUN : KEY_LABEL_STALE`.
    const consts = arg.match(KEY_CONST);
    if (consts) {
      for (const c of consts) out.push({ kind: "constant", value: c, at: off });
      continue;
    }

    // A bare local (`push(key, ...)`). Resolve it from its own `const <name> =`
    // assignment above this call — which is where the fec-drop three-way lives.
    if (/^[a-z_$][\w$]*$/.test(arg)) {
      const decl = new RegExp(
        String.raw`const\s+` + arg + String.raw`\s*(?::[^=]*)?=([\s\S]*?);`,
      );
      const d = decl.exec(body.slice(0, idx));
      const fromDecl = d?.[1]?.match(KEY_CONST);
      if (fromDecl) {
        for (const c of fromDecl) out.push({ kind: "constant", value: c, at: off });
        continue;
      }
    }

    out.push({ kind: "unresolved", value: arg.split(/\s/)[0]!, at: off });
  }
  return out;
}
