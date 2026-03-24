/**
 * Feature flags for data pipelines and cron jobs.
 *
 * All flags default to enabled. Set the env var to 'false' (or 'true' for
 * CRON_DISABLED) to disable without a code deploy.
 *
 * Usage in a pipeline:
 *   import { checkFlag } from '../feature-flags'
 *   if (!checkFlag('CONNECTIONS_PIPELINE_ENABLED', 'connections')) process.exit(0)
 */

export const FLAGS = {
  CONNECTIONS_PIPELINE_ENABLED:
    process.env["CONNECTIONS_PIPELINE_ENABLED"] !== "false",

  AI_SUMMARIES_ENABLED:
    process.env["AI_SUMMARIES_ENABLED"] !== "false",

  CRON_ENABLED:
    process.env["CRON_DISABLED"] !== "true",

  CHORD_DATA_ENABLED:
    process.env["CHORD_DATA_ENABLED"] !== "false",
} as const;

export function checkFlag(
  flag: keyof typeof FLAGS,
  pipelineName: string,
): boolean {
  if (!FLAGS[flag]) {
    console.log(`⏭  ${pipelineName} disabled via ${flag} flag`);
    return false;
  }
  return true;
}
