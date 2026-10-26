# packages/ai/CLAUDE.md

Shared Claude API layer: every AI feature in both apps routes through this
package. The pre-cc-249 file (model table, credit tables, cost-gate walkthrough,
autonomous-mode config) is `docs/archive/claude-md-ai-2026-10-25.md`.

Slow request-path query? See `packages/db/CLAUDE.md` §Materialization pattern
for slow request-path aggregations.

## The Critical Cost Rule

**Never turn on an AI feature until the credit/revenue mechanism that pays for
it is also live.** Costs are transparent, predictable, and always less than
revenue.

## Prices live in one file

**Never copy a rate into code.** The single source of truth is
`packages/db/src/ai-pricing.ts` (re-exported by `cost-config.ts`); FIX-893
exists because eight files each kept their own copy and all were ~4x low.
`calculateCostUsd` throws on a model it does not know.

Model routing: default to Sonnet; use Haiku wherever reasoning is not needed;
Opus only for premium features with an explicit credit cost. Per
`ai-pricing.ts`, Haiku 4.5 is **3x** cheaper than Sonnet 4.6 on input and on
output, not an order of magnitude, and it emits more tokens for the same text.

## Every AI pipeline calls the cost gate first

No exceptions. The $0.60-estimate-that-became-$1.86 incident is why it exists.
`costGate.gate({ pipelineName, entityCount, model, sampleFn })` before any
entity, honour `gate.approved` / `gate.entity_limit` / `gate.skip_reason`, and
`costGate.complete(run_id, …)` always, even on cancel (`src/cost-gate.ts`;
callers: `packages/data/src/pipelines/ai-summaries`, `tags/ai-tagger.ts`,
`tags/ai-classifier.ts`). Every threshold — the monthly hard limit, per-run
limits, auto-approve, the autonomous (cron/CI) rules — is in
`src/cost-config.ts`; dashboard overrides merge via `getEffectiveConfig()`
(`pipeline_state.cost_config_overrides`). Runs land in `pipeline_cost_history`.
The three env kill switches are root `CLAUDE.md` §Active environment check.

## Keys

`CIVITICS_ANTHROPIC_API_KEY` (the client, `src/client.ts`);
`ANTHROPIC_ADMIN_API_KEY` (usage reads, `src/cost-tracker.ts`).

## Official comments

Submitting an official comment is always free; only the AI drafting help costs
credits — `docs/ONBOARDING.md` §Core Principles.
