# Stage 1 — Sub-State Data Source Research

Generated: 2026-04-19 (Cowork research agent pass)

Research question: For each of the 5 deep-pilot metros (Seattle, SF, NYC, DC, Austin), what civic data is available via structured API vs. needs custom scraping vs. is effectively unavailable?

This doc is input to Stage 1 pipeline / scraper architecture decisions. The schema
design (`../STAGE_1_SCHEMA_DESIGN.md`) can proceed independently but the pipeline
registry shape is downstream of these findings.

---

## Key findings

**Legistar dominance.** Seattle, SF, NYC, and Austin all run city-level legislation on Legistar (Granicus product). DC uses its own LIMS. That means **4 of 5 city-level deployments share one scraper/adapter**, parameterized by client name (`seattle`, `sfgov`, `newyork`, `austintexas`).

**Google Civic Information API is dead.** The Representatives endpoint sunset on April 30, 2025. Eliminates the easy "address → elected official" path. Alternatives: Ballotpedia, Cicero, or Quorum.

**Socrata everywhere but sparse on governance.** All 5 cities host Socrata open-data portals (data.seattle.gov, data.sfgov.org, opendata.cityofnewyork.us, opendata.dc.gov, data.austintexas.gov). They're rich for 311 / permits / transit / crime but *light* on legislative data. Exception: SF's campaign-finance Socrata dataset is best-in-class.

**OpenStates is state-only.** Explicitly has "limited support" for municipal governments. Not a viable sub-state aggregator.

**Ballot measures: Ballotpedia.** API v3.0 covers all 5 metros. Paid tier (~$500–$5k/year depending on volume). Mission-driven nonprofits can negotiate — contact data@ballotpedia.org.

**School board data is fragmented.** No national aggregator exists for school-board *meeting records or votes*. Ballotpedia covers school-board *elections* only. Each district has its own website, often PDF-heavy. Recommend deferring to Phase 2.

**Campaign finance is metro-by-metro.** SF has a clean Socrata dataset. Others require scraping filer systems. Defer Phase 2 unless local-donor networks are MVP.

---

## Data availability matrix by metro

### Seattle

| Data type | Best source | Type | Complexity | Notes |
|---|---|---|---|---|
| City Council members | seattle.legistar.com | API | low | Legistar Web API (members + committees) |
| City Council agendas/minutes | seattle.legistar.com | API | low | Agendas back to ~2015 |
| City Council votes | seattle.legistar.com | API | low | EventItems/Votes endpoint |
| Mayor | seattle.gov + Legistar | scrape | low | Mayor listed in Legistar; actions not tracked |
| King County officials | kingcounty.legistar.com | API | med | Separate Legistar instance |
| King County Council | kingcounty.legistar.com | API | med | Board of Supervisors data |
| School Board members | SeattleSchools.org | scrape | med | HTML only |
| School Board activity | SeattleSchools.org + PDF minutes | scrape | high | No structured votes |
| Ballot measures | Ballotpedia API | API | low | Paid; covers King County |
| Local initiatives | data.seattle.gov (limited) | scrape | high | Manual from clerk's office |
| Campaign finance | seattle.gov disclosure | scrape | med | XCEL format parse |

### San Francisco

| Data type | Best source | Type | Complexity | Notes |
|---|---|---|---|---|
| Board of Supervisors members | sfgov.legistar.com | API | low | Legistar API |
| Board agendas/minutes | sfgov.legistar.com + sfbos.org | API | low | Both available |
| Board votes | sfgov.legistar.com | API | low | EventItems/Votes endpoint |
| Mayor | sfgov.legistar.com (limited) | scrape | low | Listed but not action-tracked |
| County officials | Same as city (consolidated) | API | low | City-county consolidated; one system |
| County activity | sfgov.legistar.com | API | low | Board = County Supervisors |
| School Board members | SFUSD.edu | scrape | med | SFUSD site only |
| School Board activity | SFUSD.edu PDFs | scrape | high | PDF agendas |
| Ballot measures | Ballotpedia API | API | low | Paid |
| Local initiatives | SF Ethics + data.sfgov.org | scrape | med | Partial structured data |
| Campaign finance | SF Ethics on data.sfgov.org | API | low | **Best-in-class Socrata dataset** |

### New York City

| Data type | Best source | Type | Complexity | Notes |
|---|---|---|---|---|
| City Council members | council.nyc.gov/legislation/api/ | API | low | Official NYC Council API; documented |
| Council agendas/minutes | NYC Council API | API | low | Full legislative data |
| Council votes | NYC Council API | API | low | Vote tallies, committee votes, amendments |
| Mayor/Executive | opendata.cityofnewyork.us | scrape | med | Not centrally tracked in Legistar |
| NYC Dept of Education | schools.nyc.gov | scrape | high | No Legistar; complex separate system |
| School Board activity | schools.nyc.gov (limited) | scrape | high | Fragmented across 32 districts |
| Borough Presidents | nyc.gov | scrape | med | 5 BPs; minimal structured data |
| Ballot measures | Ballotpedia + NYS BoE | API+scrape | low | State via Ballotpedia, city via scrape |
| Local initiatives | opendata.cityofnewyork.us | scrape | high | Mostly captured as Council resolutions |
| Campaign finance | Conflicts of Interest Board + Socrata | API | med | Socrata datasets available |

### Washington DC

| Data type | Best source | Type | Complexity | Notes |
|---|---|---|---|---|
| DC Council members | dccouncil.gov/legislation/ | scrape+API | low | **DC LIMS (not Legistar)**; REST API |
| Council agendas/minutes | dc.gov/legislation/ | API | low | DC LIMS full legislative data |
| Council votes | dccouncil.gov LIMS | scrape | med | Less structured than Legistar |
| Mayor/Executive | mayor.dc.gov | scrape | med | No centralized API |
| County-equivalent | (DC has no county) | n/a | n/a | Federal district structure |
| School Board (DCPS) | dcps.dc.gov | scrape | high | No API |
| School Board (Charter) | pcsb.dc.gov | scrape | high | Charter board has own governance |
| Ballot measures | Ballotpedia API | API | low | Limited DC initiatives |
| Local initiatives | opendata.dc.gov | scrape | high | Limited structured data |
| Campaign finance | OCFO | scrape | med | Electronic filing; parse required |

### Austin

| Data type | Best source | Type | Complexity | Notes |
|---|---|---|---|---|
| City Council members | austintexas.legistar.com | API | low | Legistar Web API |
| Council agendas/minutes | austintexas.legistar.com + austintexas.gov | API | low | Both available |
| Council votes | austintexas.legistar.com + data.austintexas.gov | API | low | **Council Voting Record** also on Socrata |
| Mayor | austintexas.legistar.com | scrape | low | Listed in Legistar |
| Travis County officials | traviscountylegistar.com | API | med | Separate Legistar instance |
| Travis County activity | traviscountylegistar.com | API | med | Commissioners Court |
| School Board (AISD) | austinisd.org | scrape | med | No API |
| School Board activity | austinisd.org PDFs | scrape | high | PDF agendas; votes in minutes |
| Ballot measures | Ballotpedia API | API | low | Covers TX |
| Local initiatives | data.austintexas.gov (limited) | scrape | high | Clerk's office manual |
| Campaign finance | Austin City Clerk | scrape | med | No API; filer system parse |

---

## Aggregators & alternatives

| Aggregator | Coverage | API | Pricing | Best for | Notes |
|---|---|---|---|---|---|
| Legistar (Granicus) | SEA/SF/NYC/AUS city + KING/TRAVIS counties | REST Web API | City pays; public read endpoints exist | Council votes, agendas, members | Unified scraper possible |
| DC LIMS | DC Council | REST | City pays | DC Council data | DC's proprietary |
| Ballotpedia API v3.0 | All 5 metros | Yes | Paid ~$500–$5k/yr | Ballot measures, school-board elections | No meeting records |
| Socrata (SODA API) | All 5 metros | Yes | Free | 311 / transit / SF campaign finance | Governance data sparse except SF |
| OpenStates | State only | Yes | Free/CC0 | State legislatures | NOT for local |
| Quorum Local | All 5 metros | Yes | Paid custom | Real-time meeting alerts + AI summaries | Newer; premium |
| LegiScan | All 5 metros (DC via state) | Yes | Free 30k/mo, paid tiers | State primarily | Local weaker |
| Cicero | All 5 metros | Yes | Paid | Address → officials, district geocoding | Not legislative data |
| MuckRock | All 5 metros | Yes | Free limited, paid | FOIA archive | Not legislative data |
| Google Civic API | — | **SUNSET 2025-04-30** | — | — | **DEAD**; Divisions API still live for OCD-ID lookup |

---

## Licensing

| Source | License | Reuse | AI summarization OK? |
|---|---|---|---|
| Legistar public endpoints | Public records (municipal) | Varies by city | Generally yes |
| NYC Council API | Public domain | Public domain | Yes |
| Ballotpedia API | Proprietary | API key + attribution | Yes; negotiate nonprofit rate |
| Socrata | Typically CC0 | Public domain / CC0 | Yes |
| OpenStates | CC0 | Public domain | Yes |
| SF Ethics | Open (CC0) | Public domain | Yes |
| Quorum | Proprietary | Per agreement | Contact |
| LegiScan | Proprietary | Per subscription | Enterprise = AI OK |
| Cicero | Proprietary | Per API agreement | Check |

---

## Cost / egress

- **Free tier wins:** OpenStates, Socrata, LegiScan (30k/mo), NYC Council API, DC LIMS, Ballotpedia (nonprofit rate via data@ballotpedia.org).
- **Egress risk:** Nightly Legistar scrapes for SEA/SF/AUS ≈ 50–100 MB/month each. Well within 250 GB/mo Pro budget.
- **API costs:** Ballotpedia negotiable for mission nonprofits; Quorum Local custom-priced; LegiScan free tier likely sufficient for local.

---

## Recommended pipeline approach

1. **One generic Legistar adapter.** Parameterize by client: `seattle`, `sfgov`, `newyork`, `austintexas`, `kingcounty`, `traviscountylegistar`. Public Web API: `https://webapi.legistar.com/v1/{Client}/{Endpoint}`. Covers 4 metros + 2 counties with one codebase.
2. **Separate DC LIMS adapter.** Different schema; single-metro cost.
3. **County level: defer Phase 1** except where city-county consolidated (SF). Seattle/Austin counties are separate Legistar instances — add after city is stable.
4. **School boards: defer Phase 2.** No API; per-district PDF scraping. Ballotpedia elections API gives the seat-election data cheaply.
5. **Ballot measures: Ballotpedia (paid).** Low Phase 1 priority unless election season; essential afterwards.
6. **Campaign finance: defer Phase 2** except SF (Socrata already structured).

---

## Schema implications

- **External source table** should allow multiple sources per item (Legistar + Socrata both providing overlapping Austin vote data — no reason to pick one).
- **Jurisdictions** must handle city-county consolidated (SF = one jurisdiction with both `municipal` + `county` roles) and separated (Seattle + King County as siblings). Consider a `jurisdiction_aliases` or `governing_bodies` child to model this cleanly.
- **Meetings table** should exist (not implicit in proposals) — Legistar data is meeting-centric, agendas hang off meetings, votes hang off agenda items.
- **Scrape runs** → `pipeline_state` existing pattern is fine; add per-scraper egress + cost counters.
- **Ballotpedia** access needs a secret + rate-limit tracker; defer until we pull the trigger.

---

## Reference URLs

APIs & aggregators:
- Legistar Web API: https://webapi.legistar.com/Home/Examples
- NYC Council Legislative API: https://council.nyc.gov/legislation/api/
- Ballotpedia Developer Portal: https://developer.ballotpedia.org/
- LegiScan API: https://legiscan.com/legiscan
- Quorum Local: https://www.quorum.us/products/local/
- Cicero API: https://www.cicerodata.com/api/

City council systems:
- Seattle: https://seattle.legistar.com/
- San Francisco: https://sfgov.legistar.com/
- NYC: https://council.nyc.gov/ (API at https://council.nyc.gov/legislation/api/)
- DC: https://dccouncil.gov/legislation/ (LIMS, not Legistar)
- Austin: https://austintexas.legistar.com/

Open data portals:
- Seattle: https://data.seattle.gov/
- SF: https://data.sfgov.org/
- NYC: https://opendata.cityofnewyork.us/
- DC: https://opendata.dc.gov/
- Austin: https://data.austintexas.gov/
