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
