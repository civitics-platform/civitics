-- FIX-α — Honest relabel of the Supabase "egress" metric.
--
-- The dashboard egress figure is sourced from the Prometheus counter
-- node_network_transmit_bytes_total (raw NIC transmit on the DB compute), which
-- includes replication, PITR/WAL, and intra-AWS traffic — NOT just bytes sent to
-- connected clients. It is therefore an UPPER BOUND on Supabase *billable*
-- egress, and reads well above it (~272 GB MTD vs. the 250 GB Pro allowance,
-- i.e. a false 101% "critical").
--
-- Supabase exposes no public Management API endpoint for billable egress
-- (api.supabase.com/v1 probed 2026-06-19: usage.api-counts returns 200 but every
-- egress/bandwidth variant and the org usage/daily-stats/billing paths 404). So
-- we keep the NIC counter as an honest proxy: the snapshot writer now records it
-- with source='estimated' (gray "~ Est." badge, excluded from critical/warning),
-- and this migration relabels the limit rows so the card is self-describing.
--
-- No threshold/limit VALUE changes — only display_label + notes.

UPDATE public.platform_limits
   SET display_label = 'Egress (≈ NIC transmit, upper bound)',
       notes = COALESCE(notes || ' ', '')
         || 'Sourced from node_network_transmit_bytes_total (raw NIC transmit), '
         || 'which counts all node egress incl. replication/PITR/intra-AWS — an '
         || 'upper bound that reads above Supabase billable egress. Shown as '
         || 'an estimate; not used for cost/critical alerting.'
 WHERE service = 'supabase'
   AND metric = 'egress_bytes'
   AND plan IN ('free', 'pro');
