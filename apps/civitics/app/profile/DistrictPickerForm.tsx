"use client";

import { useState, useEffect } from "react";

const US_STATES: [string, string][] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"],
  ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
];

interface Rep {
  id: string;
  name: string;
  role: string;
  party?: string;
}

interface Props {
  initialState: string | null;
  initialDistrict: number | null;
}

export function DistrictPickerForm({ initialState, initialDistrict }: Props) {
  const [homeState, setHomeState] = useState(initialState ?? "");
  const [homeDistrict, setHomeDistrict] = useState<number | "">(initialDistrict ?? "");
  const [districts, setDistricts] = useState<number[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Fetch district list whenever state changes
  useEffect(() => {
    if (!homeState) { setDistricts([]); return; }
    fetch(`/api/profile/districts?state=${homeState}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setDistricts(d.districts ?? []))
      .catch(() => setDistricts([]));
    setHomeDistrict("");
  }, [homeState]);

  // Load representatives if we already have a configured district on mount
  useEffect(() => {
    if (!initialState) return;
    fetch("/api/graph/my-representatives", { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        if (d.configured) setReps(d.reps ?? []);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/profile/preferences", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          home_state: homeState || null,
          home_district: homeDistrict !== "" ? homeDistrict : null,
        }),
      });
      setSaved(true);
      // Refresh representatives preview
      const res = await fetch("/api/graph/my-representatives", { credentials: "include" });
      const d = await res.json();
      if (d.configured) setReps(d.reps ?? []);
    } catch {
      // fail silently — user can retry
    } finally {
      setSaving(false);
    }
  }

  const partyColor = (party?: string) => {
    if (party === "democrat") return "text-civic-blue";
    if (party === "republican") return "text-accent";
    return "text-viz-7";
  };

  return (
    <div className="mt-6 border border-rule bg-paper p-6">
      <h3 className="font-serif text-base font-semibold text-ink">Your Congressional District</h3>
      <p className="mt-1 text-sm text-ink-soft">
        Set your home district to see your representatives in the connection graph.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        {/* State picker */}
        <div className="flex-1">
          <label className="block text-xs font-medium text-ink-soft mb-1">State</label>
          <select
            value={homeState}
            onChange={e => setHomeState(e.target.value)}
            className="w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Select state…</option>
            {US_STATES.map(([abbr, name]) => (
              <option key={abbr} value={abbr}>{name}</option>
            ))}
          </select>
        </div>

        {/* District picker */}
        <div className="flex-1">
          <label className="block text-xs font-medium text-ink-soft mb-1">House District</label>
          <select
            value={homeDistrict}
            onChange={e => setHomeDistrict(e.target.value === "" ? "" : parseInt(e.target.value, 10))}
            disabled={!homeState || districts.length === 0}
            className="w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:bg-paper-2 disabled:text-ink-soft/50"
          >
            <option value="">Select district…</option>
            {districts.map(d => (
              <option key={d} value={d}>CD-{d}</option>
            ))}
          </select>
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={!homeState || saving}
          className="shrink-0 border-[1.5px] border-ink bg-ink px-4 py-2 text-sm font-semibold text-paper transition-colors hover:border-accent hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
      </div>

      {/* Representatives preview */}
      {reps.length > 0 && (
        <div className="mt-4 border-t border-rule pt-4">
          <p className="text-xs font-medium text-ink-soft mb-2">Your federal representatives</p>
          <ul className="space-y-1.5">
            {reps.map(rep => (
              <li key={rep.id} className="flex items-center gap-2 text-sm">
                <span className={`font-medium ${partyColor(rep.party)}`}>
                  {rep.name}
                </span>
                <span className="text-ink-soft/60">&middot; {rep.role}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-soft/60">
            Your alignment with these representatives will appear on the connection graph.
          </p>
        </div>
      )}
    </div>
  );
}
