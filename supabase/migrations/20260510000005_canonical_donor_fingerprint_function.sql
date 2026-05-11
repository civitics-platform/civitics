-- 20260510000005_canonical_donor_fingerprint_function.sql
-- FIX-239 Layer 1 + FIX-244.
--
-- Layer 1 of the donor-dedup strategy from docs/FIX_239_INVESTIGATION.md §4.
-- A conservative write-time normalization that collapses the largest fragmentation
-- class (honorifics, MR/MRS/MD/PHD/etc) without touching the SR/JR/middle-initial
-- signal — preserves the §2.4 high-risk cases while collapsing the §2.3 anchors.
--
-- FIX-244 bundled in: apostrophes and periods are stripped to EMPTY STRING (not
-- whitespace). The previous `normalizeName()` turned `O'BRIEN` into `O BRIEN`,
-- splitting ~5,000 rows into a leading single-letter token. Now `O'BRIEN`
-- normalizes to `OBRIEN` and `M.D.` to `MD`.
--
-- The TS function `donorFingerprint()` in
-- packages/data/src/pipelines/fec-bulk/indiv.ts mirrors this SQL function byte
-- for byte — same uppercasing, same regex sequence, same noise-token set, same
-- preservation of generational tokens (JR, SR, II, III, IV, V). Idempotency of
-- the FEC pipeline depends on the two staying in sync.
--
-- The function is IMMUTABLE so it can be used in expression indexes if we ever
-- want one, and so the planner can fold it into set-based scans.

CREATE OR REPLACE FUNCTION public.canonical_donor_fingerprint(
  raw_name TEXT,
  zip5     TEXT
) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  cleaned   TEXT;
  tokens    TEXT[];
  filtered  TEXT[];
  tok       TEXT;
BEGIN
  IF raw_name IS NULL OR length(trim(raw_name)) = 0 THEN
    RETURN NULL;
  END IF;

  -- Step 1: uppercase.
  cleaned := upper(raw_name);

  -- Step 2: strip apostrophes and periods to EMPTY STRING (FIX-244).
  --   O'BRIEN -> OBRIEN ; M.D. -> MD ; ST. CLAIR -> ST CLAIR
  cleaned := regexp_replace(cleaned, '[''.]', '', 'g');

  -- Step 3: replace all other non-alphanumeric chars with whitespace, collapse runs.
  cleaned := regexp_replace(cleaned, '[^A-Z0-9 ]', ' ', 'g');
  cleaned := regexp_replace(cleaned, '\s+', ' ', 'g');
  cleaned := trim(cleaned);

  IF cleaned = '' THEN
    RETURN NULL;
  END IF;

  -- Step 4: tokenize.
  tokens := string_to_array(cleaned, ' ');

  -- Step 5: drop honorific noise tokens. Generational tokens (JR/SR/II/III/IV/V)
  -- are NOT in this list and are preserved verbatim — that's how the §2.4
  -- father/son cases stay split.
  filtered := ARRAY[]::TEXT[];
  FOREACH tok IN ARRAY tokens LOOP
    IF tok NOT IN (
      'MR','MRS','MS','DR','MD','PHD','ESQ','REV','HON','CPA','CFP','JD','RN','DDS','DO','MBA'
    ) THEN
      filtered := array_append(filtered, tok);
    END IF;
  END LOOP;

  IF coalesce(array_length(filtered, 1), 0) = 0 THEN
    RETURN NULL;
  END IF;

  -- Step 6: emit `tokens.join(' ') + '|' + zip5`. If zip5 is blank we still
  -- return the name portion alone so the function never returns a stray
  -- trailing `|`.
  IF zip5 IS NULL OR length(trim(zip5)) = 0 THEN
    RETURN array_to_string(filtered, ' ');
  END IF;

  RETURN array_to_string(filtered, ' ') || '|' || trim(zip5);
END;
$$;

COMMENT ON FUNCTION public.canonical_donor_fingerprint(TEXT, TEXT) IS
  'FIX-239 Layer 1 + FIX-244. Conservative donor fingerprint: uppercase, strip apostrophes/periods to empty, strip other punctuation to whitespace, drop honorific noise tokens, preserve generational tokens (JR/SR/II-V) and middle initials, append |zip5. Mirrors TS donorFingerprint() in packages/data/src/pipelines/fec-bulk/indiv.ts byte for byte — pipeline idempotency depends on the two staying in sync.';
