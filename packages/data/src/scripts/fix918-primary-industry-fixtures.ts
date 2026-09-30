/**
 * FIX-918 — fixture donors for primary_industry_tag(), the one home of "a
 * donor's primary industry". Each fixture is a tag set plus the pick the rule
 * must make:
 *
 *   (generated_by = 'curated') DESC, confidence DESC NULLS LAST,
 *   (generated_by = 'ai') ASC, tag
 *
 * Includes the wrong-but-green shapes: a tie on every key (the alphabet must
 * still decide, deterministically), a null confidence, and an id with no tags.
 * Entity ids are synthetic (the f9180000- prefix); entity_tags has no FK to
 * financial_entities, so nothing else is needed for them to exist.
 */

export type FixtureTag = {
  tag: string;
  generated_by: "rule" | "curated" | "ai";
  confidence: number | null;
  naics_code?: string;
};

export type Fixture = {
  name: string;
  entity_id: string;
  tags: FixtureTag[];
  /** null → the id is passed in but carries no industry tag, so no row comes back. */
  expected: string | null;
};

const id = (n: number) => `f9180000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const FIX918_FIXTURES: Fixture[] = [
  { name: "single tag", entity_id: id(1),
    tags: [{ tag: "health", generated_by: "rule", confidence: 0.8 }],
    expected: "health" },
  { name: "two rule tags, equal confidence 0.7 — the alphabet decides",
    entity_id: id(2),
    tags: [{ tag: "labor", generated_by: "rule", confidence: 0.7 },
           { tag: "agriculture", generated_by: "rule", confidence: 0.7 }],
    expected: "agriculture" },
  { name: "tie on every key at 0.8 — still deterministic, still the alphabet",
    entity_id: id(3),
    tags: [{ tag: "tech", generated_by: "rule", confidence: 0.8 },
           { tag: "retail", generated_by: "rule", confidence: 0.8 }],
    expected: "retail" },
  { name: "curated beats rule regardless of letter",
    entity_id: id(4),
    tags: [{ tag: "agriculture", generated_by: "rule", confidence: 0.8 },
           { tag: "utilities", generated_by: "curated", confidence: 1.0 }],
    expected: "utilities" },
  { name: "curated beats a higher-confidence ai tag",
    entity_id: id(5),
    tags: [{ tag: "tech", generated_by: "curated", confidence: 0.5 },
           { tag: "agriculture", generated_by: "ai", confidence: 0.99 }],
    expected: "tech" },
  { name: "NAICS 0.85 beats a single keyword match at 0.8",
    entity_id: id(6),
    tags: [{ tag: "finance", generated_by: "rule", confidence: 0.8 },
           { tag: "tech", generated_by: "rule", confidence: 0.85, naics_code: "541330" }],
    expected: "tech" },
  { name: "NAICS 0.85 beats an ambiguous keyword pair at 0.7",
    entity_id: id(7),
    tags: [{ tag: "agriculture", generated_by: "rule", confidence: 0.7 },
           { tag: "labor", generated_by: "rule", confidence: 0.7 },
           { tag: "manufacturing", generated_by: "rule", confidence: 0.85, naics_code: "332710" }],
    expected: "manufacturing" },
  { name: "ai vs rule at EQUAL confidence — rule wins",
    entity_id: id(8),
    tags: [{ tag: "agriculture", generated_by: "ai", confidence: 0.8 },
           { tag: "tech", generated_by: "rule", confidence: 0.8 }],
    expected: "tech" },
  { name: "ai vs NAICS at equal 0.85 — rule wins",
    entity_id: id(9),
    tags: [{ tag: "agriculture", generated_by: "ai", confidence: 0.85 },
           { tag: "tech", generated_by: "rule", confidence: 0.85, naics_code: "541330" }],
    expected: "tech" },
  { name: "ai ABOVE rule confidence — the more confident ai tag wins (confidence before provenance)",
    entity_id: id(10),
    tags: [{ tag: "agriculture", generated_by: "ai", confidence: 0.95 },
           { tag: "tech", generated_by: "rule", confidence: 0.8 }],
    expected: "agriculture" },
  { name: "two ai tags — the more confident wins",
    entity_id: id(11),
    tags: [{ tag: "agriculture", generated_by: "ai", confidence: 0.7 },
           { tag: "tech", generated_by: "ai", confidence: 0.9 }],
    expected: "tech" },
  { name: "null confidence sorts LAST, not first",
    entity_id: id(12),
    tags: [{ tag: "agriculture", generated_by: "rule", confidence: null },
           { tag: "tech", generated_by: "rule", confidence: 0.7 }],
    expected: "tech" },
  { name: "an id with no industry tag returns no row",
    entity_id: id(13), tags: [], expected: null },
];
