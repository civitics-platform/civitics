/**
 * Legistar Web API response types.
 *
 * Legistar uses a prefix convention: every field on a Body starts with "Body",
 * every field on a Person starts with "Person", etc.
 *
 * API base: https://webapi.legistar.com/v1/{Client}/{Endpoint}
 * Reference: https://webapi.legistar.com/Home/Examples
 */

// ---------------------------------------------------------------------------
// Bodies (governing bodies — councils, committees)
// ---------------------------------------------------------------------------

export interface LegistarBody {
  BodyId:             number;
  BodyGuid:           string;
  BodyLastModifiedUtc: string;
  BodyName:           string;
  BodyTypeId:         number;
  BodyTypeName:       string;          // e.g. "City Council", "Committee", "Board"
  BodyMeetFlag:       0 | 1;
  BodyActiveFlag:     0 | 1;
  BodySort:           number;
  BodyDescription:    string | null;
  BodyContactNameId:  number | null;
  BodyContactFullName: string | null;
  BodyContactPhone:   string | null;
  BodyContactEmail:   string | null;
  BodyNumberOfMembers: number | null;
  BodyUsedControlFlag: 0 | 1;
  BodyDisplayCommentFlag: 0 | 1;
  BodyDefaultPassRules: number | null;
}

// ---------------------------------------------------------------------------
// Persons (officials / members)
// ---------------------------------------------------------------------------

export interface LegistarPerson {
  PersonId:           number;
  PersonGuid:         string;
  PersonLastModifiedUtc: string;
  PersonLastName:     string;
  PersonFirstName:    string;
  PersonFullName:     string;
  PersonActiveFlag:   0 | 1;
  PersonCanViewFlag:  0 | 1;
  PersonUsedSponsorFlag: 0 | 1;
  PersonAddress1:     string | null;
  PersonCity1:        string | null;
  PersonState1:       string | null;
  PersonZip1:         string | null;
  PersonPhone:        string | null;
  PersonFax:          string | null;
  PersonEmail:        string | null;
  PersonWWW:          string | null;
  PersonAddress2:     string | null;
  PersonCity2:        string | null;
  PersonState2:       string | null;
  PersonZip2:         string | null;
  PersonPhone2:       string | null;
  PersonFax2:         string | null;
  PersonEmail2:       string | null;
  PersonWWW2:         string | null;
}

// ---------------------------------------------------------------------------
// OfficeRecords (person ↔ body membership with term dates)
// ---------------------------------------------------------------------------
//
// The membership table Legistar exposes but the pipeline historically ignored
// (FIX-471). Ties a PersonId to a BodyId with a start/end term window and a
// title/member-type. This — NOT the all-time Persons roster — is the current-
// membership signal: a person is a *current* member of a body iff they have an
// OfficeRecord on it whose end date is null or in the future.
export interface LegistarOfficeRecord {
  OfficeRecordId:            number;
  OfficeRecordGuid:          string;
  OfficeRecordLastModifiedUtc: string;
  OfficeRecordPersonId:      number;
  OfficeRecordBodyId:        number;
  OfficeRecordBodyName:      string | null;
  OfficeRecordTitle:         string | null;   // e.g. "Council Member", "Supervisor", "Chair"
  OfficeRecordMemberTypeId:  number | null;
  OfficeRecordMemberTypeName: string | null;
  OfficeRecordStartDate:     string | null;   // ISO datetime — term start
  OfficeRecordEndDate:       string | null;   // ISO datetime — term end (null/future = current)
  OfficeRecordSort:          number | null;
}

// ---------------------------------------------------------------------------
// Matters (legislation / bills)
// ---------------------------------------------------------------------------

export interface LegistarMatter {
  MatterId:           number;
  MatterGuid:         string;
  MatterLastModifiedUtc: string;
  MatterFile:         string | null;   // File/bill number e.g. "CB 119723" or "Ord 22-01"
  MatterName:         string | null;   // Short name
  MatterTitle:        string | null;   // Full title
  MatterTypeId:       number;
  MatterTypeName:     string;          // "Ordinance" | "Resolution" | "Council Bill" | ...
  MatterStatusId:     number;
  MatterStatusName:   string;          // "Passed" | "In Committee" | "Introduced" | ...
  MatterBodyId:       number | null;
  MatterBodyName:     string | null;
  MatterIntroDate:    string | null;   // ISO datetime
  MatterAgendaDate:   string | null;
  MatterPassedDate:   string | null;
  MatterEnactmentDate: string | null;
  MatterEnactmentNumber: string | null;
  MatterRequester:    string | null;
  MatterNotes:        string | null;
  MatterVersion:      string | null;
  MatterCost:         number | null;
  MatterText1:        string | null;   // varies by city
  MatterText2:        string | null;
  MatterText3:        string | null;
  MatterText4:        string | null;
  MatterText5:        string | null;
  MatterDate1:        string | null;
  MatterDate2:        string | null;
  MatterEXText1:      string | null;
  MatterEXText2:      string | null;
  MatterEXText3:      string | null;
  MatterEXText4:      string | null;
  MatterEXText5:      string | null;
  MatterEXDate1:      string | null;
  MatterEXDate2:      string | null;
  MatterAgiloftId:    number | null;
  MatterReference:    string | null;
  MatterRestrictViewViaWeb: 0 | 1;
}

// ---------------------------------------------------------------------------
// Events (meetings)
// ---------------------------------------------------------------------------

export interface LegistarEvent {
  EventId:            number;
  EventGuid:          string;
  EventLastModifiedUtc: string;
  EventBodyId:        number;
  EventBodyName:      string;
  EventDate:          string;          // ISO date "2024-01-15T00:00:00"
  EventTime:          string | null;   // "2:00 PM" — combine with EventDate
  EventVideoStatus:   string | null;
  EventAgendaStatusId: number;
  EventAgendaStatusName: string;       // "Draft" | "Final" | "Published"
  EventMinutesStatusId: number;
  EventMinutesStatusName: string;
  EventLocation:      string | null;
  EventAgendaFile:    string | null;   // URL to agenda PDF
  EventMinutesFile:   string | null;   // URL to minutes PDF
  EventAgendaLastPublishedUTC: string | null;
  EventMinutesLastPublishedUTC: string | null;
  EventComment:       string | null;
  EventVideoPath:     string | null;
  EventMedia:         string | null;
  EventInSiteURL:     string | null;
}

// ---------------------------------------------------------------------------
// EventItems (agenda items)
// ---------------------------------------------------------------------------

export interface LegistarEventItem {
  EventItemId:          number;
  EventItemGuid:        string;
  EventItemLastModifiedUtc: string;
  EventItemEventId:     number;
  EventItemAgendaSequence: number | null;
  EventItemMinutesSequence: number | null;
  EventItemAgendaNumber: string | null;   // e.g. "1.", "A.", "CB1"
  EventItemVideo:       number | null;
  EventItemVideoIndex:  number | null;
  EventItemVersion:     string | null;
  EventItemAgendaNote:  string | null;
  EventItemMinutesNote: string | null;
  EventItemActionId:    number | null;
  EventItemActionName:  string | null;    // "Approved" | "Failed" | "Referred" | ...
  EventItemActionText:  string | null;
  EventItemPassedFlag:  0 | 1 | null;
  EventItemPassedFlagName: string | null; // "Pass" | "Fail" | "No Action"
  EventItemRollCallFlag: 0 | 1;           // 1 = a vote was taken on this item
  EventItemFlagExtra:   0 | 1;
  EventItemTitle:       string | null;
  EventItemMatterId:    number | null;
  EventItemMatterGuid:  string | null;
  EventItemMatterFile:  string | null;
  EventItemMatterName:  string | null;
  EventItemMatterType:  string | null;
  EventItemMatterStatus: string | null;
}

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

export interface LegistarVote {
  VoteId:           number;
  VoteGuid:         string;
  VoteLastModifiedUtc: string;
  VoteEventItemId:  number;
  VoteValueId:      number;
  VoteValueName:    string;   // "Yes" | "Yea" | "No" | "Nay" | "Abstain" | "Present" | "Excused" | "NV"
  VotePersonId:     number;
  VotePersonName:   string;
  VoteSortOrder:    number | null;
}

// ---------------------------------------------------------------------------
// Internal config types
// ---------------------------------------------------------------------------

export interface MetroConfig {
  /** Legistar API client name, e.g. 'seattle', 'sfgov', 'newyork', 'austintexas'. */
  client:       string;
  /** Display name for logging. */
  name:         string;
  /** Display slug embedded in the xsr source string (`legistar:${slug}`), decoupled
   *  from the API client name so resolveSource renders clean labels (FIX-411). */
  slug:         string;
  /** Source string written to external_source_refs. */
  source:       string;
  /** UUID of this city's jurisdiction in our DB (resolved at startup). */
  jurisdictionId: string;
  /**
   * Legistar BodyId of this metro's primary legislative body — the real council
   * whose members are the ones we surface as a roster (FIX-471). Hardcoded per
   * metro because Legistar's BodyTypeName is unreliable for identifying it: the
   * classifier picked "City Council Addendum Agenda" (an agenda variant) over
   * Austin's real "City Council" (BodyId 138, typed "Primary Legislative Body"),
   * and SF's Board of Supervisors has no `municipal_council`-typed body at all.
   * officials.governing_body_id for every person in the metro is keyed to this
   * body; is_active reflects current membership derived from OfficeRecords.
   */
  councilBodyId: number;
}

/** IDs resolved during the pipeline run for cross-step lookups. */
export interface MetroIdMaps {
  /** LegistarBodyId → local governing_body UUID */
  bodyIdMap:     Map<number, string>;
  /** LegistarPersonId → local official UUID */
  personIdMap:   Map<number, string>;
  /** LegistarMatterId → local shadow.proposals UUID */
  matterIdMap:   Map<number, string>;
  /** LegistarEventId → local shadow.meetings UUID */
  eventIdMap:    Map<number, string>;
  /** LegistarEventItemId → local shadow.agenda_items UUID */
  eventItemIdMap: Map<number, string>;
}
