

## Brainstorming Ideas







## BUGS — Fix These First

- Several Build Errors
        -Cannot find module '@civitics/ai/cost-gate' - pre-existing module resolution issue
        -congress/members.ts - pre-existing
        -fec/index.ts - pre-existing
        -index.ts spending_records - pre-existing
        -entity_connections_rebuild - pre-existing
        -pac-classify/index.ts donor_name - pre-existing

- On several pages, after clicking an something
POST
	http://127.0.0.1:3000/api/platform/web-vitals
Status
400

- pnpm dev Warning: <w> [webpack.cache.PackFileCacheStrategy] Serializing big strings (140kiB) impacts deserialization performance (consider using Buffer instead and decode when needed)


---

## GENERAL / CROSS-CUTTING

- brainstorm dropdowns on top Nav Bar
ex:     -initiatives        -officials
            -bills              -congress
            -regulations        -house
            -executive orders   -local
            -local              -my officials

- officials / proposals/ initiatives by location
- small dev user interface (.exe?) with several buttons, may need a small plan/brainstorm session
        - launch pipeline (a button for each pipeline)
        - env.local flags set/reset (one for each setting)
        - fixes ops buttons (archive/clean/housekeep)
        - descriptions of each setting
        - show logs (pipeline / usage / etc...)
        - git / supabase status and typical commands
        - other useful scripts / etc...

- Tag contract awardees by sector
- Reorganize/Archive/Verify docs folder
- Hit list notes, quick comment about workflow Craig>HitList>FIXES>fixes-archive
- co_sponsorship, appointment, oversight — these derive from proposal_cosponsors, career_history, and agencies.governing_body_id respectively. The pipelines haven't seeded those source tables on either side. 

---

## HOMEPAGE

- Brainstorm Layout Update - Political ads (video) and discussion (+ratings?) - strategy
- Remove the 2 buttons directly under search bar
- Remove the 'browse comment periods' banner
- District Boundary Data needed
- connection graph - small lightweight interactive graph banner instead of just the button

---

## OFFICIALS
- Federal vs State tag on the officials list
- Bills in graph shows IDs, not names
- Procedural votes should be filtered by default (can be unfiltered manually)


---

## PROPOSALS

- Clicking on cards does not link to proposals/[id] page
- Add more Filters to Search - 69k proposals need lots of filtering options
- state/county/local filters 
- 

---

## PROPOSALS [ID]


---

## INITIATIVES


---


## INTIIATIVES [ID]

- Make a "status" section and place below the initiative text - make it collapsible and place the quality gate section inside of the status - also plan for different status messages for each stage of the initiative
- Comments filterable by user type/location/verified

## CIVIC INITIATIVES


---

## AGENCIES

- Loads quite slowly
- Are we able to load budget data? (or do we already have that data, and just need to show it?)
- Hierarchy (show a full heirarchy on main page - with budget data - maybe a d3 type that show heirarchy andd budget size) 

---

## GRAPH

- By state group not working
- toggle button is misaligned
- Initial Settings clickable in the middle of a 'blank' inital state with a 'make your own graph' tutorial button that walks user through how to add entities and connections and option to hide 
- The settings still needs some work - Brainstorm session - probably a spec file
        -- auto populate available connections
        -- options for node size
        -- Indentation of the heirarchies is inconsistent 
        -- Go though the d3 documentation / brainstorm additional options
        -- probably lots i am forgetting so add your own ideas as you see fit
        -- maybe a 'build a custom group' option
- Agencies by spending/budget
- State data on Officials is not showing up properly in graph (ex: treemap all officials by state - state unknown)

---

## DASHBOARD

- Dashboard data remains stale (might be using seed data? - not updating properly?)

---

## Account/Profile

- Unique Display Name (Default: User1234)
- Presets/options?
- Positions / Following / Comments

---

## INFRASTRUCTURE & PERFORMANCE

- Data Integrity, some issues discovered - some states don't have 2 senators - suspect incorrect house members as well

---

## COMMUNITY & AUTH


---

## DOCUMENTATION (Open Source Readiness)