/**
 * RPC grant drift — FIX-1113.
 *
 * REPORT-ONLY. Lists every public routine `anon` or `authenticated` can
 * EXECUTE on the audited database and diffs it against
 * ./rpc-grant-allowlist.json. Additions are warnings; nothing here blocks a
 * build and nothing here revokes anything.
 *
 * WHY IT IS NEEDED. Supabase grants EXECUTE to anon+authenticated on every new
 * function by default, and a CREATE OR REPLACE that drops-and-recreates
 * re-opens a grant a previous migration closed. FIX-834 audited and classified
 * the whole surface once; nothing then watched it, so it drifted back — which
 * is how FIX-1113 found `refresh_official_donor_rollup_incremental()`
 * anon-executable on prod. A once-a-week diff is the cheapest thing that turns
 * a silent re-widening into a line in a report.
 *
 * WHY WARNING AND NOT ERROR. The weekly audit commits its report to main. An
 * error-severity finding on a false positive would red the workflow for a
 * grant that is legitimately new, and the fix for that is a human reading a
 * caller — not a failed job. Severity escalates to `error` only for a
 * PROCEDURE, where the rule is unambiguous (see below).
 *
 * THE PROCEDURE RULE. Every prokind='p' routine on this platform is a heavy
 * pipeline procedure driven by pg_cron as postgres. None has ever had a
 * legitimate anon/authenticated caller. So an anon-executable procedure is
 * always drift, and is reported as an error even when a name is somehow
 * allow-listed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Check, CheckResult } from "../types";

type AllowList = {
  anon_public: string[];
  authed_user: string[];
  triggers_and_helpers: string[];
};

type GrantRow = {
  proname: string;
  kind: "function" | "procedure";
  anon_x: boolean;
  auth_x: boolean;
  secdef: boolean;
};

function loadAllowList(): AllowList {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "rpc-grant-allowlist.json"), "utf8");
  const parsed = JSON.parse(raw) as Partial<AllowList>;
  return {
    anon_public: parsed.anon_public ?? [],
    authed_user: parsed.authed_user ?? [],
    triggers_and_helpers: parsed.triggers_and_helpers ?? [],
  };
}

export const grantChecks: Check = async (ctx) => {
  const out: CheckResult[] = [];
  const allow = loadAllowList();
  const allowed = new Set<string>([
    ...allow.anon_public,
    ...allow.authed_user,
    ...allow.triggers_and_helpers,
  ]);

  const rows = await ctx.query<GrantRow>(
    `SELECT p.proname,
            CASE p.prokind WHEN 'f' THEN 'function' ELSE 'procedure' END AS kind,
            has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_x,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
            p.prosecdef AS secdef
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (has_function_privilege('anon',          p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      ORDER BY p.proname`,
  );

  // Deduplicate overloads: the allow-list is by name, because a signature
  // change is not a new grant decision.
  const byName = new Map<string, GrantRow>();
  for (const r of rows) if (!byName.has(r.proname)) byName.set(r.proname, r);

  const additions = [...byName.values()].filter((r) => !allowed.has(r.proname));
  const procedures = [...byName.values()].filter((r) => r.kind === "procedure");

  out.push({
    category: "grants.rpc_executable_additions",
    severity: additions.length === 0 ? "info" : "warning",
    expected: 0,
    actual: additions.length,
    sample: additions.slice(0, 25).map((r) => ({
      routine: r.proname,
      kind: r.kind,
      anon: r.anon_x,
      authenticated: r.auth_x,
      security_definer: r.secdef,
    })),
    detail:
      "public routines EXECUTE-able by anon or authenticated that are NOT in " +
      "checks/rpc-grant-allowlist.json. Report-only (FIX-1113). Classify " +
      "before acting: a route or client caller means add it to the allow-list; " +
      "no caller, or only pg_cron/service_role callers, means it wants a " +
      "REVOKE ... FROM PUBLIC, anon, authenticated in a migration.",
  });

  out.push({
    category: "grants.rpc_executable_procedures",
    severity: procedures.length === 0 ? "info" : "error",
    expected: 0,
    actual: procedures.length,
    sample: procedures.slice(0, 25).map((r) => ({
      routine: r.proname,
      anon: r.anon_x,
      authenticated: r.auth_x,
    })),
    detail:
      "PROCEDUREs EXECUTE-able by anon or authenticated. Every procedure here " +
      "is a heavy pipeline procedure driven by pg_cron as postgres, so this " +
      "should always be zero — FIX-1113 revoked the 13 that had drifted open. " +
      "Any row is drift, regardless of the allow-list.",
  });

  // Informational only: allow-listed names absent from this database. Local and
  // prod legitimately differ, so this is never a failure.
  const present = new Set(byName.keys());
  const missing = [...allowed].filter((n) => !present.has(n)).sort();
  out.push({
    category: "grants.allowlist_entries_absent",
    severity: "info",
    expected: "n/a",
    actual: missing.length,
    sample: missing.slice(0, 25),
    detail:
      "Allow-listed routines that are not anon/authenticated-executable in " +
      "this database. Expected to be non-zero when auditing anything other " +
      "than prod, and after a deliberate revoke. Informational.",
  });

  return out;
};
