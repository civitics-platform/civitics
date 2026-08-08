/**
 * Feature flags for data pipelines and cron jobs.
 *
 * Boolean flags default to enabled. Set the env var to 'false' (or 'true' for
 * CRON_DISABLED) to disable without a code deploy.
 *
 * Usage in a pipeline:
 *   import { checkFlag } from '../feature-flags'
 *   if (!checkFlag('CONNECTIONS_PIPELINE_ENABLED', 'connections')) process.exit(0)
 *
 * ENRICHMENT_MODE is a non-boolean string flag; read FLAGS.ENRICHMENT_MODE
 * directly.
 */

export const FLAGS = {
  CONNECTIONS_PIPELINE_ENABLED:
    process.env["CONNECTIONS_PIPELINE_ENABLED"] !== "false",

  AI_SUMMARIES_ENABLED:
    process.env["AI_SUMMARIES_ENABLED"] !== "false",

  AI_NARRATIVE_ENABLED:
    process.env["AI_NARRATIVE_ENABLED"] !== "false",

  AI_TAGGER_ENABLED:
    process.env["AI_TAGGER_ENABLED"] !== "false",

  CRON_ENABLED:
    process.env["CRON_DISABLED"] !== "true",

  // FIX-998 — TEMPORARY hold on the nightly path's fec_bulk invocation while
  // FIX-995 is open. Deliberately shaped like CRON_ENABLED (opt-out via a
  // *_DISABLED var whose only truthy value is the literal "true") so an unset
  // env is exactly today's behavior. Read ONCE in the nightly orchestrator and
  // passed to the pure trigger predicates in pipelines/fec-hold.ts — this is
  // the single place the env var is parsed.
  //
  // Scope note: this holds the NIGHTLY path only. fec-backfill.yml invokes
  // runFecBulkPipeline() directly (data:fec-bulk:ci), does not route through
  // runNightlySync, and is deliberately unaffected — the ingest runs by
  // operator dispatch while the hold is on.
  FEC_NIGHTLY_BULK_ENABLED:
    process.env["FEC_NIGHTLY_BULK_DISABLED"] !== "true",

  CHORD_DATA_ENABLED:
    process.env["CHORD_DATA_ENABLED"] !== "false",

  ENRICHMENT_MODE: (process.env["CIVITICS_ENRICHMENT_MODE"] === "queue"
    ? "queue"
    : "inline") as "inline" | "queue",
} as const;

type BooleanFlag = {
  [K in keyof typeof FLAGS]: typeof FLAGS[K] extends boolean ? K : never;
}[keyof typeof FLAGS];

export function checkFlag(flag: BooleanFlag, pipelineName: string): boolean {
  if (!FLAGS[flag]) {
    console.log(`⏭  ${pipelineName} disabled via ${flag} flag`);
    return false;
  }
  return true;
}
