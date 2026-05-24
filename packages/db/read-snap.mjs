import { createClient } from '@supabase/supabase-js';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) { console.error('missing env'); process.exit(1); }
const db = createClient(url, key);
const { data, error } = await db
  .from('status_snapshot')
  .select('fetched_at, query_time_ms, section_times, error')
  .order('fetched_at', { ascending: false })
  .limit(3);
if (error) { console.error(error); process.exit(1); }
for (const row of data) {
  console.log('--- ', row.fetched_at, 'query_ms:', row.query_time_ms, 'err:', row.error);
  const st = row.section_times || {};
  const keys = [
    'self_tests',
    'self_tests:warren_search',
    'self_tests:warren_votes_count',
    'self_tests:vote_yes_count',
    'self_tests:derived_drift',
    'self_tests:chord_industry_flows',
    'self_tests:anthropic_usage',
    'connection_types',
  ];
  for (const k of keys) console.log('  ', k.padEnd(40), st[k] ?? 'n/a');
}
