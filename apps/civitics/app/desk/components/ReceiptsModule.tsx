export type ReceiptItem = {
  action_type: string;
  entity_type: string;
  entity_id: string;
  ref_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
  // resolved via the shared entity-label resolver (FIX-597); null if unresolved.
  label: string | null;
  href: string | null;
  chip: string | null;
};

// Human label per get_user_receipts action_type.
const ACTION_LABEL: Record<string, string> = {
  comment: "Commented on",
  question: "Asked about",
  evidence_note: "Added an evidence note to",
  position: "Took a position on",
  evidence_card: "Filed an evidence card on",
  statement: "Stated on",
};

function receiptDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

/**
 * Receipts — the "permanent record" ledger and brand centerpiece. One row per
 * authored action from get_user_receipts() (FIX-596): mono date · action label ·
 * resolved entity link. Entity names resolve via the shared resolver (FIX-597).
 */
export function ReceiptsModule({ items }: { items: ReceiptItem[] }) {
  return (
    <section className="border border-rule bg-paper">
      <div className="border-b border-rule px-5 py-3.5">
        <p className="mb-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">
          Your permanent record
        </p>
        <h2 className="font-serif text-lg font-semibold text-ink">Receipts</h2>
      </div>

      {items.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-soft">
          Nothing on the record yet. Comments, positions, and evidence you contribute are logged
          here — permanently.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {items.map((r, i) => {
            const action = ACTION_LABEL[r.action_type] ?? "Acted on";
            return (
              <li
                key={`${r.action_type}:${r.ref_id ?? r.entity_id}:${i}`}
                className="flex items-baseline gap-3 px-5 py-2.5"
              >
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-soft/80">
                  {receiptDate(r.created_at)}
                </span>
                <p className="min-w-0 text-sm text-ink">
                  <span className="text-ink-soft">{action} </span>
                  {r.label && r.href ? (
                    <a href={r.href} className="font-medium text-ink hover:text-accent">
                      {r.label}
                    </a>
                  ) : (
                    <span className="font-medium text-ink-soft italic">a record</span>
                  )}
                  {r.chip && (
                    <span className="ml-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-soft/70">
                      {r.chip}
                    </span>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
