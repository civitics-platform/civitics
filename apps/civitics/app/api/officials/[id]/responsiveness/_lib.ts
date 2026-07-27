// FIX-905 — the A-F letter grade and the response-rate percentage were removed.
// Both were public SCORES on a public profile, which the platform is committed
// against, and neither carried a minimum-sample floor: one closed window with no
// response rendered a public "F". What survives is the RECORD — the raw window
// counts and the recent-window ledger. The canonical responsiveness judgment is
// now the small-n-disciplined tiering in app/lib/engagement.ts (EngagementBadges).

export type ResponsivenessData = {
  responded:     number;
  no_response:   number;
  open:          number;
  total_closed:  number;
  recent: Array<{
    initiative_id:    string;
    initiative_title: string;
    scope:            string;
    response_type:    string;
    responded_at:     string | null;
    window_closes_at: string;
    window_opened_at: string;
  }>;
};
