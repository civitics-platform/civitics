-- =============================================================================
-- 0013_fix_api_usage_logs_costs.sql
-- Zero out inflated cost_cents rows from pre-token-tracking era.
--
-- Context: Before migration 0010 added input_tokens/output_tokens columns,
-- the ai-summaries pipeline used Math.ceil() which inflated each call to
-- exactly 1 cent (actual cost ~0.02¢ per call — ~50x inflation).
--
-- These rows have input_tokens IS NULL (columns didn't exist when inserted).
-- We zero their cost_cents and preserve the original value in metadata.
-- ai-tagger session-total rows (cost_cents = 10.01) are left intact.
--
-- DOWN: No rollback needed — original values are preserved in metadata.
-- =============================================================================

UPDATE api_usage_logs
SET
  cost_cents = 0,
  metadata   = metadata || jsonb_build_object(
    'note',                  'cost_inflated_pre_token_tracking',
    'original_cost_cents',   cost_cents
  )
WHERE input_tokens IS NULL
  AND cost_cents = 1.0000;
