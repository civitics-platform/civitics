/**
 * packages/graph/src/nodeId.ts
 *
 * Single source of truth for the graph's node / edge-endpoint id scheme
 * (FIX-849). Before this module the graph carried THREE un-normalized
 * conventions:
 *   - the connections route emits type-prefixed `official:{uuid}` /
 *     `financial_entity:{uuid}` (the majority producer — the canonical form)
 *   - the group route emitted `donor-{uuid}` + raw official uuids
 *   - FocusEntity ids are RAW uuids
 * Raw-vs-prefixed `===` comparisons silently never matched, so the same
 * real-world entity rendered as 2–3 distinct nodes depending on the path it
 * was reached by, focus-entity removal was a no-op, and SharedConnectionsBar
 * was permanently empty.
 *
 * Canonical scheme = `${type}:${uuid}` for every entity node/edge endpoint.
 * FocusEntity ids stay RAW uuids (decision 2 — they come from search / URL /
 * saved views; reshaping them would break saved-view back-compat for zero
 * gain). The two are NEVER compared with `===`; always through matchesFocus /
 * isFocusNode here.
 */

/** UUID (v4-ish) shape — the entity primary-key form across the platform. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DB entity-type prefixes used in canonical `${type}:${uuid}` ids. These are
 * the SOURCE-TABLE types (entity_connections.from_type / to_type), NOT the
 * mapped GraphNode.type — a financial_entity keeps the `financial_entity:`
 * prefix even though its node renders as pac / individual / corporation.
 *
 * Aggregate / synthetic prefixes (bracket, tail, employer, mv, group, user,
 * sector, vendor) are deliberately EXCLUDED: they are not single entities and
 * must never resolve to a focus uuid.
 */
export const NODE_ID_TYPES = [
  'official',
  'agency',
  'proposal',
  'financial_entity',
  'governing_body',
  'initiative',
] as const;
export type NodeIdType = (typeof NODE_ID_TYPES)[number];

const TYPE_PREFIX_RE = new RegExp(`^(${NODE_ID_TYPES.join('|')}):(.+)$`);

/** Compose the canonical id for an entity node / edge endpoint. */
export function makeNodeId(type: NodeIdType, uuid: string): string {
  return `${type}:${uuid}`;
}

/**
 * Pull the entity uuid out of a canonical `${type}:${uuid}` id, or return the
 * id unchanged when it is already a bare uuid. Returns `null` for aggregate /
 * group / user / bracket / tail / employer ids — anything that is not a single
 * entity node and therefore can never correspond to a focus entity.
 *
 * Strictness matters: `bracket:{officialUuid}:{tier}` embeds a uuid but is a
 * distinct aggregate node, so it must NOT extract to the official's uuid (else
 * the bracket node would inherit the focus ring / shared-connection identity).
 */
export function extractUuid(id: string): string | null {
  if (UUID_RE.test(id)) return id;
  const m = TYPE_PREFIX_RE.exec(id);
  if (m && UUID_RE.test(m[2]!)) return m[2]!;
  return null;
}

/**
 * True when a node / edge-endpoint id refers to the given focus entity. Focus
 * ids are RAW uuids; node/edge ids are canonical `${type}:${uuid}`.
 */
export function matchesFocus(id: string, focusUuid: string): boolean {
  if (id === focusUuid) return true;
  return extractUuid(id) === focusUuid;
}

/**
 * Set-membership form of matchesFocus for the hot D3 loops: O(1) per node —
 * one regex + set lookup — vs re-scanning the focus list. `focusUuids` is a set
 * of RAW focus uuids.
 */
export function isFocusNode(id: string, focusUuids: ReadonlySet<string>): boolean {
  if (focusUuids.has(id)) return true;
  const u = extractUuid(id);
  return u != null && focusUuids.has(u);
}
