# packages/ai/CLAUDE.md

## Purpose
Shared Claude API service layer. All AI features across both apps route through this package.

When a request-path query becomes slow as data grows, the durable fix is
materialization. See `../db/CLAUDE.md` — *Materialization pattern for
slow request-path aggregations* — for shape options (single-row MV,
per-entity MV, rolling-history snapshot table), refresh hook placement,
read-path conventions with live-compute fallback, and the table of existing
materializations to model off.

---

## API Key

```
ANTHROPIC_API_KEY
```

---

## Model Routing

| Model | Use case | Cost |
|-------|----------|------|
| claude-haiku-4-5 | Simple tasks, cached lookups, classification | ~$0.25/M tokens (12x cheaper than Sonnet) |
| claude-sonnet-4-6 | Standard features, summaries, drafting | Standard |
| claude-opus-4-6 | Premium complex tasks only | Highest cost |

**Default to Sonnet.** Use Haiku for any task that doesn't require reasoning. Use Opus only for premium-tier features with explicit credit cost.

---

## Caching Strategy

- **Plain language summaries** — generated once on document ingestion, stored in Supabase, served free to unlimited users
- Cache key: `{entity_type}:{entity_id}:{version}` — version bumps when prompt changes
- Cache hit rate target: **80%+**
- Cached content is a public good — no credit cost to read it
- Store cache in Supabase (Phase 1) or R2 (Phase 2+)

---

## Credit Gating

Every per-user AI call costs civic credits. There is no open-ended free AI access.

| Feature | Credits | Model |
|---------|---------|-------|
| Personalized impact analysis | 2 | Sonnet |
| Comment draft | 1 | Sonnet |
| Connection mapping query | 3 | Sonnet |
| Legislation draft (basic) | 5 | Sonnet |
| Legislation draft (with citations) | 15 | Opus |
| Multi-hop connection analysis | 10 | Opus |
| "Explain this graph" | 1 (cached per state hash) | Sonnet |

Free tier: 3 personalized queries/day, 1 comment draft/day. These are hard limits enforced server-side.

---

## The Critical Cost Rule

**Never turn on an AI feature until the credit/revenue mechanism that pays for it is also live.**

Costs must be: transparent, predictable, and always less than revenue.

---

## Cost Control Rules

1. Cache hit rate target: 80%+
2. Model routing: use Haiku whenever reasoning isn't needed (12x cost reduction)
3. Hard rate limits per user per day (enforced server-side, not client-side)
4. Never open-ended free API access — every personalized call has a credit cost
5. Seek Anthropic nonprofit/partnership rate — apply for startup credits early
6. All AI costs are transparent to users before they spend credits

---

## Free AI Features (no credits)

These are cached and shared across all users:
- Plain language bill/regulation summaries (generated once on ingestion)
- Basic "What does this mean?" Q&A on cached data

These never cost the user anything. Platform absorbs cost from the one-time generation.

---

## Credit-Gated Features

- Personalized impact analysis ("what does this mean for me as a small business owner")
  - Answers are shareable (reduces repeat queries)
- Comment drafting assistant (3 questions → structured official comment)
- Direct submission to regulations.gov
- Connection mapping queries
- Legislation drafting studio
- FOIA request builder

## Premium Features (Opus, higher credit cost)

- Full legislation drafting with legal citations
- Complex multi-hop connection analysis
- Comparative analysis across jurisdictions

---

## Official Comment Submission Exception

Direct submission of official comments to regulations.gov is **always free** — no credits required.
This is a constitutional right. The AI drafting assistance costs credits; the submission itself never does.

---

## Cost Management System

EVERY AI pipeline MUST call the cost gate before processing any entities. No exceptions.
The $0.60-estimate-that-became-$1.86-actual incident is why this exists.

```ts
import { costGate } from "@civitics/ai/cost-gate";

async function runPipeline(entities: Entity[]) {
  const gate = await costGate.gate({
    pipelineName: "ai_tagger",          // matches per_run_limits key in cost-config.ts
    entityCount:  entities.length,
    model:        "claude-haiku-4-5-20251001",

    // sampleFn runs ONE real entity through the actual prompt.
    // This is what makes estimates accurate — real tokens, real cost.
    sampleFn: async () => anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: buildPrompt(entities[0]) }],
    }),
  });

  if (!gate.approved) return;   // user cancelled or budget exceeded

  // Respect entity limit if gate capped us due to budget
  const toProcess = gate.entity_limit
    ? entities.slice(0, gate.entity_limit)
    : entities;

  let totalInput = 0, totalOutput = 0;

  for (const entity of toProcess) {
    const response = await anthropic.messages.create({...});
    totalInput  += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
  }

  // Always call complete — even on cancellation
  await costGate.complete(gate.run_id!, totalInput, totalOutput, "claude-haiku-4-5-20251001");
}
```

### What the cost gate does

1. Checks hard monthly limit ($3.50) — blocks immediately if exceeded
2. Samples 3 real API calls to measure actual token usage
3. Projects full cost with historical variance adjustment (+20% buffer if no history)
4. Auto-approves if under $0.05; otherwise prompts for approval
5. Blocks if run would exceed monthly budget; offers reduced entity count
6. Records run start in `pipeline_cost_history` (Supabase)
7. After completion: records actual costs, calculates variance ratio
8. Alerts on large variance (>50% over estimate)

### Configuration

All thresholds live in `packages/ai/src/cost-config.ts`:

```ts
monthly_hard_limit_usd:  3.50   // all pipelines stop if hit
monthly_warning_usd:     2.50   // dashboard banner
auto_approve_under_usd:  0.05   // no prompt needed
variance_pause_threshold: 1.5   // pause at 50% over estimate
estimate_sample_size:     3     // real API calls to sample

per_run_limits: {
  ai_summaries:  0.50,
  ai_tagger:     0.50,
  ai_classifier: 0.25,
  ai_narrative:  0.10,
  default:       0.20,
}
```

### Mid-run variance check

At the midpoint of any pipeline loop, compare actual spend to estimate:

```ts
const halfwayCost = calculateCostUsd(totalInput, totalOutput);
const projectedFinal = halfwayCost * 2;

if (projectedFinal > gate.estimate.estimated_total_usd * COST_CONFIG.variance_pause_threshold) {
  // pause and ask — see pattern in pipeline spec
}
```

### DB tables

- `pipeline_cost_history` — per-run estimates, actuals, variance ratio, status
- `api_usage_logs` — token-level usage (also written by cost gate on completion)
- `pipeline_state` key `cost_alert_latest` — current alert shown on dashboard
- `pipeline_state` key `cost_config_overrides` — admin budget overrides (from dashboard)

---

## Autonomous Mode (Phase 2)

Cron and CI environments have no terminal — `costGate.gate()` uses pre-configured rules
instead of prompting. Import `isAutonomousMode()` to check whether the current process
is running autonomously.

### Detection (isAutonomousMode)

```ts
import { isAutonomousMode } from "@civitics/ai/cost-gate";
// returns true when any of these are set:
//   VERCEL_CRON_SIGNATURE  — set by Vercel on all cron invocations
//   AUTONOMOUS=true        — explicit override for testing
//   CI=true                — standard CI environment variable
```

### Autonomous gate flow

1. Same hard monthly limit check and budget alerts as interactive mode
2. **1 sample call** (not 3) to estimate cost — faster in cron context
3. Checks in order — skip if any fail:
   - Budget remaining ≥ $0.50 (`min_budget_remaining_usd`)
   - Entity count ≤ 50 (`max_entity_count`)
   - Estimated cost ≤ $0.10 (`max_auto_approve_usd`)
   - Last run of this pipeline did not fail or pause
   - Last run variance ≤ 1.5× estimate
4. If all pass → auto-approved, pipeline runs
5. If any fail → pipeline skipped, reason logged to `pipeline_cost_history` (status='skipped')
   and `pipeline_state` cost_alert_latest

### Autonomous configuration

All thresholds live in `COST_CONFIG.autonomous` in `cost-config.ts`:

```ts
autonomous: {
  max_auto_approve_usd:    0.10,  // max cost for auto-approval
  min_budget_remaining_usd: 0.50, // skip if budget below this
  max_entity_count:        50,    // skip if suspiciously many entities
  skip_if_last_run_failed: true,  // skip after failed/paused run
  skip_if_variance_over:   1.5,   // skip if last run was 50%+ over estimate
  sample_size_override:    1,     // use 1 sample instead of 3
}
```

These can be overridden at runtime from the dashboard (stored in `pipeline_state`
key `cost_config_overrides`). Use `getEffectiveConfig()` to get merged config.

### Testing autonomous mode

```bash
# Simulate cron locally
AUTONOMOUS=true pnpm --filter @civitics/data data:nightly

# Should: NOT prompt for input, auto-approve small runs, skip oversized runs,
#         log everything to DB, return NightlySyncResults
```

### GateResult skip_reason

When autonomous mode skips a pipeline, `gate()` returns:
```ts
{
  approved:      false,
  auto_approved: false,
  skip_reason:   "Budget too low for autonomous run. Remaining: $0.45 (minimum: $0.50)",
  estimate:      CostEstimate,
}
```
Check `gate.skip_reason` to surface the reason in dashboard logs.
