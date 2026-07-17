/**
 * Legistar API → shadow schema row converters.
 *
 * Each function takes a Legistar API object and produces a plain row object
 * ready to upsert into the corresponding shadow table (or public table for
 * governing_bodies and officials, which stay in the public schema per the
 * Stage 1 design doc).
 */

import type {
  LegistarBody,
  LegistarPerson,
  LegistarMatter,
  LegistarEvent,
  LegistarEventItem,
  LegistarVote,
  LegistarOfficeRecord,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert Legistar 0/1 active flag to boolean. */
const isActive = (flag: 0 | 1 | null): boolean => flag === 1;

/** Trim to ISO date string (YYYY-MM-DD) from a Legistar datetime, or null. */
function isoDate(dt: string | null | undefined): string | null {
  if (!dt) return null;
  const d = new Date(dt);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Map Legistar MatterTypeName → public.proposal_type enum. */
export function matterTypeToProposalType(typeName: string | null): string {
  const t = (typeName ?? "").toLowerCase();
  if (t.includes("ordinance") || t.includes("council bill")) return "ordinance";
  if (t.includes("resolution"))                                return "resolution";
  if (t.includes("bill"))                                      return "bill";
  if (t.includes("budget") || t.includes("appropriation"))    return "budget";
  if (t.includes("appointment") || t.includes("confirmat"))   return "appointment";
  if (t.includes("amendment"))                                 return "amendment";
  if (t.includes("initiative") || t.includes("referendum"))   return "referendum";
  return "other";
}

/** Map Legistar MatterStatusName → public.proposal_status enum. */
export function matterStatusToProposalStatus(statusName: string | null): string {
  const s = (statusName ?? "").toLowerCase();
  if (s.includes("passed") || s.includes("approved") || s.includes("enacted")) return "enacted";
  if (s.includes("failed") || s.includes("denied") || s.includes("rejected"))  return "vetoed";
  if (s.includes("signed"))                                                      return "signed";
  if (s.includes("in committee") || s.includes("referred") || s.includes("held")) return "in_committee";
  if (s.includes("floor") || s.includes("calendar"))                             return "floor_vote";
  if (s.includes("withdrawn") || s.includes("tabled"))                           return "vetoed";
  if (s.includes("introduced") || s.includes("filed"))                           return "introduced";
  return "introduced";
}

/** Map Legistar VoteValueName → shadow.votes.vote CHECK enum. */
export function legistarVoteValue(valueName: string): string | null {
  const v = valueName.toLowerCase().trim();
  if (v === "yes" || v === "yea" || v === "aye")                   return "yes";
  if (v === "no"  || v === "nay" || v === "naye")                  return "no";
  if (v === "abstain" || v === "abstaining" || v === "pass")       return "abstain";
  if (v === "present")                                             return "present";
  if (v === "excused" || v === "absent" || v === "not voting" || v === "nv") return "not_voting";
  if (v === "recused")                                             return "not_voting";
  return null; // unknown — caller should skip
}

/** Map Legistar BodyTypeName → public.governing_body_type enum.
 *
 * FIX-471: BodyTypeName is the *type* label, and cities use it inconsistently —
 * the real council is often typed "Primary Legislative Body" (SF, Austin) while
 * agenda/procedural variants get typed "City Council Addendum Agenda", "Council
 * Discussion", etc. The old rule matched the latter as `municipal_council` and
 * missed the former. Now: (a) "primary legislative body" counts as a council;
 * (b) procedural/agenda variants are explicitly excluded so they never win the
 * council slot even when their type string contains "city council". */
export function bodyTypeToGoverningBodyType(typeName: string | null): string {
  const t = (typeName ?? "").toLowerCase();
  // Procedural / agenda variants — never a governing body proper.
  if (t.includes("addendum") || t.includes("agenda") ||
      t.includes("work session") || t.includes("special called") ||
      t.includes("discussion") || t.includes("briefing")) {
    return "other";
  }
  if (t.includes("primary legislative body") ||
      t.includes("city council") || t.includes("board of supervisors") ||
      t.includes("common council") || t.includes("city commission")) {
    return "municipal_council";
  }
  if (t.includes("school board"))    return "school_board";
  if (t.includes("mayor") || t.includes("executive")) return "executive";
  return "other";
}

// ---------------------------------------------------------------------------
// Current council membership (FIX-471)
// ---------------------------------------------------------------------------

/**
 * Derive the set of PersonIds who are *current* members of a council body from
 * its OfficeRecords.
 *
 * Primary rule: a person is current iff they hold an OfficeRecord on the council
 * body whose end date is null or in the future.
 *
 * SF fallback: some clients (sfgov) stamp an end date on *every* OfficeRecord,
 * including sitting members, so the primary rule yields zero. When that happens
 * AND we know the body's seat count, fall back to the `expectedSeats` most-recent
 * distinct persons by OfficeRecord start date on that body — an approximation of
 * "the current cohort" that keeps the roster plausibly sized instead of empty.
 * Returns `{ personIds, usedFallback }` so the caller can log which path ran.
 */
export function currentCouncilMemberPersonIds(
  officeRecords: LegistarOfficeRecord[],
  councilBodyId: number,
  expectedSeats: number | null,
  now: Date = new Date(),
): { personIds: Set<number>; usedFallback: boolean } {
  const onBody = officeRecords.filter((r) => r.OfficeRecordBodyId === councilBodyId);

  const current = new Set<number>();
  for (const r of onBody) {
    const end = r.OfficeRecordEndDate ? new Date(r.OfficeRecordEndDate) : null;
    if (!end || isNaN(end.getTime()) || end >= now) {
      current.add(r.OfficeRecordPersonId);
    }
  }
  if (current.size > 0) return { personIds: current, usedFallback: false };

  // Fallback: top-N distinct persons by most-recent start date.
  if (!expectedSeats || expectedSeats <= 0) {
    return { personIds: current, usedFallback: false };
  }
  const byRecentStart = [...onBody].sort((a, b) => {
    const ta = a.OfficeRecordStartDate ? new Date(a.OfficeRecordStartDate).getTime() : 0;
    const tb = b.OfficeRecordStartDate ? new Date(b.OfficeRecordStartDate).getTime() : 0;
    return tb - ta;
  });
  const fallback = new Set<number>();
  for (const r of byRecentStart) {
    if (fallback.size >= expectedSeats) break;
    fallback.add(r.OfficeRecordPersonId);
  }
  return { personIds: fallback, usedFallback: true };
}

// ---------------------------------------------------------------------------
// Governing body row
// ---------------------------------------------------------------------------

export interface GoverningBodyRow {
  type:            string;
  name:            string;
  short_name:      string | null;
  jurisdiction_id: string;
  is_active:       boolean;
  metadata:        object;
}

export function bodyToGoverningBodyRow(
  body: LegistarBody,
  jurisdictionId: string,
): GoverningBodyRow {
  return {
    type:            bodyTypeToGoverningBodyType(body.BodyTypeName),
    name:            body.BodyName,
    short_name:      body.BodyName.slice(0, 40) || null,
    jurisdiction_id: jurisdictionId,
    is_active:       isActive(body.BodyActiveFlag),
    metadata:        {
      legistar_body_id:   body.BodyId,
      legistar_body_type: body.BodyTypeName,
      member_count:       body.BodyNumberOfMembers ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Official row
// ---------------------------------------------------------------------------

export interface OfficialRow {
  governing_body_id: string;
  jurisdiction_id:   string;
  full_name:         string;
  first_name:        string;
  last_name:         string;
  role_title:        string;
  is_active:         boolean;
  source_ids:        Record<string, string>;
  metadata:          object;
}

export function personToOfficialRow(
  person: LegistarPerson,
  source: string, // e.g. 'legistar:seattle'
  governingBodyId: string,
  jurisdictionId: string,
  isCurrentMember: boolean, // FIX-471: derived from OfficeRecords, NOT PersonActiveFlag
): OfficialRow {
  return {
    governing_body_id: governingBodyId,
    jurisdiction_id:   jurisdictionId,
    full_name:         person.PersonFullName,
    first_name:        person.PersonFirstName,
    last_name:         person.PersonLastName,
    role_title:        "Council Member",
    // Legistar's PersonActiveFlag is "not soft-deleted", not "sits on the
    // council" — it flags ~40-95% of the all-time roster true, flooding the
    // council page. is_active now means current council member (FIX-471).
    is_active:         isCurrentMember,
    source_ids:        { [source]: String(person.PersonId) },
    metadata:          {
      legistar_person_id: person.PersonId,
      email:              person.PersonEmail ?? null,
      phone:              person.PersonPhone ?? null,
      website:            person.PersonWWW  ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Proposal row (shadow.proposals)
// ---------------------------------------------------------------------------

export interface ShadowProposalRow {
  type:             string;
  status:           string;
  jurisdiction_id:  string;
  governing_body_id: string | null;
  title:            string;
  short_title:      string | null;
  introduced_at:    string | null;
  last_action_at:   string | null;
  resolved_at:      string | null;
  external_url:     string | null;
  metadata:         object;
}

export function matterToProposalRow(
  matter: LegistarMatter,
  jurisdictionId: string,
  governingBodyId: string | null,
  client: string,
): ShadowProposalRow {
  const title = (matter.MatterTitle ?? matter.MatterName ?? matter.MatterFile ?? "Untitled").trim();
  const resolvedAt =
    matter.MatterEnactmentDate ?? matter.MatterPassedDate ?? null;

  return {
    type:             matterTypeToProposalType(matter.MatterTypeName),
    status:           matterStatusToProposalStatus(matter.MatterStatusName),
    jurisdiction_id:  jurisdictionId,
    governing_body_id: governingBodyId,
    title:            title.slice(0, 500),
    short_title:      (matter.MatterName ?? matter.MatterFile ?? null)?.slice(0, 80) ?? null,
    introduced_at:    isoDate(matter.MatterIntroDate),
    last_action_at:   isoDate(matter.MatterAgendaDate ?? matter.MatterIntroDate),
    resolved_at:      isoDate(resolvedAt),
    external_url:     matter.MatterReference ?? null,
    metadata:         {
      legistar_matter_id:   matter.MatterId,
      legistar_matter_type: matter.MatterTypeName,
      legistar_client:      client,
      file_number:          matter.MatterFile ?? null,
      enactment_number:     matter.MatterEnactmentNumber ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Bill details row (shadow.bill_details)
// ---------------------------------------------------------------------------

export interface ShadowBillDetailsRow {
  bill_number:      string;
  chamber:          string;
  session:          string;
  jurisdiction_id:  string;
  legistar_matter_id: string;
}

export function matterToBillDetailsRow(
  matter: LegistarMatter,
  proposalId: string,
  jurisdictionId: string,
): ShadowBillDetailsRow & { proposal_id: string } {
  // Session = year of introduction (city councils use calendar years, not Congress terms)
  const year = matter.MatterIntroDate
    ? String(new Date(matter.MatterIntroDate).getFullYear())
    : String(new Date().getFullYear());

  return {
    proposal_id:      proposalId,
    bill_number:      (matter.MatterFile ?? `LEG-${matter.MatterId}`).slice(0, 80),
    chamber:          "council",
    session:          year,
    jurisdiction_id:  jurisdictionId,
    legistar_matter_id: String(matter.MatterId),
  };
}

// ---------------------------------------------------------------------------
// Meeting row (shadow.meetings)
// ---------------------------------------------------------------------------

export interface ShadowMeetingRow {
  governing_body_id: string;
  meeting_type:      string;
  title:             string | null;
  scheduled_at:      string;
  location:          string | null;
  status:            string;
  agenda_url:        string | null;
  minutes_url:       string | null;
  video_url:         string | null;
  metadata:          object;
}

export function eventToMeetingRow(
  event: LegistarEvent,
  governingBodyId: string,
  client: string,
): ShadowMeetingRow {
  // Parse combined date + time
  let scheduled_at: string;
  try {
    const base = new Date(event.EventDate);
    if (event.EventTime) {
      // EventTime like "2:00 PM" — parse and splice in
      const timeParts = event.EventTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (timeParts) {
        let hours = parseInt(timeParts[1], 10);
        const mins = parseInt(timeParts[2], 10);
        const ampm = timeParts[3].toUpperCase();
        if (ampm === "PM" && hours !== 12) hours += 12;
        if (ampm === "AM" && hours === 12) hours = 0;
        base.setHours(hours, mins, 0, 0);
      }
    }
    scheduled_at = base.toISOString();
  } catch {
    scheduled_at = new Date(event.EventDate).toISOString();
  }

  const status = (() => {
    const s = event.EventAgendaStatusName?.toLowerCase() ?? "";
    if (s.includes("cancel")) return "cancelled";
    if (s.includes("in progress")) return "in_progress";
    const d = new Date(event.EventDate);
    return d < new Date() ? "completed" : "scheduled";
  })();

  return {
    governing_body_id: governingBodyId,
    meeting_type:      "regular",       // Legistar doesn't reliably expose type; refine in post-process
    title:             event.EventComment?.slice(0, 200) ?? null,
    scheduled_at,
    location:          event.EventLocation?.slice(0, 200) ?? null,
    status,
    agenda_url:        event.EventAgendaFile ?? null,
    minutes_url:       event.EventMinutesFile ?? null,
    video_url:         event.EventVideoPath ?? null,
    metadata:          {
      legistar_event_id:    event.EventId,
      legistar_client:      client,
      agenda_status:        event.EventAgendaStatusName ?? null,
      minutes_status:       event.EventMinutesStatusName ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Agenda item row (shadow.agenda_items)
// ---------------------------------------------------------------------------

export interface ShadowAgendaItemRow {
  meeting_id:  string;
  proposal_id: string | null;
  sequence:    number;
  title:       string;
  item_type:   string | null;
  description: string | null;
  outcome:     string | null;
  metadata:    object;
}

export function eventItemToAgendaItemRow(
  item: LegistarEventItem,
  meetingId: string,
  proposalId: string | null,
  client: string,
): ShadowAgendaItemRow {
  const outcome = item.EventItemActionName?.toLowerCase() ?? null;
  const mappedOutcome = !outcome ? null
    : outcome.includes("pass") || outcome.includes("approv") || outcome.includes("adopt") ? "passed"
    : outcome.includes("fail") || outcome.includes("reject") || outcome.includes("denied") ? "failed"
    : outcome.includes("table") ? "tabled"
    : outcome.includes("continu") ? "continued"
    : outcome.includes("withdr") ? "withdrawn"
    : null;

  const itemType = item.EventItemRollCallFlag === 1 ? "vote"
    : item.EventItemTitle?.toLowerCase().includes("public comment") ? "public_comment"
    : "discussion";

  const sequence = item.EventItemAgendaSequence ?? item.EventItemMinutesSequence ?? 0;

  return {
    meeting_id:  meetingId,
    proposal_id: proposalId,
    sequence,
    title:       (item.EventItemTitle ?? item.EventItemMatterName ?? item.EventItemAgendaNumber ?? "Item").slice(0, 500),
    item_type:   itemType,
    description: item.EventItemAgendaNote?.slice(0, 1000) ?? null,
    outcome:     mappedOutcome,
    metadata:    {
      legistar_event_item_id: item.EventItemId,
      legistar_client:        client,
      action_name:            item.EventItemActionName ?? null,
      passed_flag:            item.EventItemPassedFlag ?? null,
      roll_call_flag:         item.EventItemRollCallFlag,
    },
  };
}

// ---------------------------------------------------------------------------
// Vote row (shadow.votes)
// ---------------------------------------------------------------------------

export interface ShadowVoteRow {
  bill_proposal_id: string;
  official_id:      string;
  vote:             string;
  voted_at:         string;
  roll_call_id:     string;
  vote_question:    string | null;
  chamber:          string;
  agenda_item_id:   string | null;
  source_url:       string | null;
  metadata:         object;
}

export function legistarVoteToRow(
  legiVote: LegistarVote,
  billProposalId: string,
  officialId: string,
  votedAt: string,
  agendaItemId: string | null,
  client: string,
): ShadowVoteRow | null {
  const voteValue = legistarVoteValue(legiVote.VoteValueName);
  if (!voteValue) return null;

  return {
    bill_proposal_id: billProposalId,
    official_id:      officialId,
    vote:             voteValue,
    voted_at:         votedAt,
    roll_call_id:     String(legiVote.VoteEventItemId),
    vote_question:    null,
    chamber:          "council",
    agenda_item_id:   agendaItemId,
    source_url:       null,
    metadata:         {
      legistar_vote_id:      legiVote.VoteId,
      legistar_client:       client,
      legistar_vote_value:   legiVote.VoteValueName,
      legistar_person_id:    legiVote.VotePersonId,
    },
  };
}
