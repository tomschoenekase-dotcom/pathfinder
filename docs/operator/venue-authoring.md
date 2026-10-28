# Venue authoring contract

How an agent builds or changes a venue guide through the operator MCP. This is the authoring
contract; the accepted JSON is defined only by the live validator. Call `operator.get_manual` with
`section` set to `venue-authoring` to get this text together with `schema`, a JSON Schema generated
from that validator, so the field list can never drift from what the server accepts.

Available today: everything in this guide unless it is marked **Planned**.

## Quality gates

A package that passes the schema can still make a weak guide. A venue moves through five gates in
order, and a report names the highest gate it has evidence for. Never claim a gate from a check
that did not run, and never claim a later gate from an earlier one.

| Gate                    | Means                                                                                                                     | Evidence required                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Researched           | Every fact traces to a current source about this exact venue                                                              | A source ledger outside the package: for each record, its source URL, the date you read it, and the exact sentence or table it came from. Identity proof (official domain, city and state) so a same-name venue elsewhere cannot leak in. Every conflict written down with the decision taken                                                                                       |
| 2. Package validated    | `venues.check_package` with the target venue says `ready`, and every `authoring` finding is fixed or justified in writing | The check output saved on the day of import. A check from an earlier day does not count: dates expire (`EXPIRES_SOON`, `STALE_DATE`)                                                                                                                                                                                                                                                |
| 3. Imported             | The import is `APPLIED` to the right venue                                                                                | The receipt (`proposalId`, `status`, `operationId`), then `venues.list_content` showing the records. A re-import of the same package with the same `operationId` returns the same receipt; a corrected package uses a new `operationId` and v3 `update` operations with ids, never a second `create` of the same records                                                            |
| 4. Visitor tested       | Real questions get grounded answers in the venue's own guide                                                              | At least 25 questions written as a visitor would ask them (not from record titles), covering hours today, prices, a named thing, a list ("what rides are there"), a family or access need, food, a follow-up, something the venue does not have, and something unknown. Each answer checked against the ledger: correct, complete for lists, and "not sure, ask staff" when unknown |
| 5. Ready to demonstrate | A person can open it and it works                                                                                         | `venues.get_guest_link` says `usable`; the guest page checked at phone width (390 px) and desktop, including the keyboard; the gate 4 questions re-asked there; no stale or expiring record inside the demo window                                                                                                                                                                  |

Gates 3 to 5 need a real venue and the owner's authorization to import and publish. Gates 4 and
5 are tested on the live guide: a published guide whose link has not been shared is the test
environment, and no one else sees it until the owner shares the link. There is one environment,
so make later changes to a guide that visitors already use outside the venue's opening hours. If a
gate is blocked, report it as blocked with the reason.

## The workflow and what each step means

1. **Read.** `venues.list_content` with `representation` `LEGACY_PLACE` (places) or
   `LEGACY_KNOWLEDGE` (topics) shows the venue's current package records with their ids.
   `appearance.get` shows the time zone and chat appearance.
2. **Check (a preview).** `venues.check_package` with the package as `payload` or an attached
   `file`. Nothing is saved and no model is called. It returns:
   - `errors`: the package does not match the schema or cannot apply. Each names the `path`, the
     problem (`message`), a `fix` and, where useful, a valid `example`. Nothing imports until
     `errorCount` is 0.
   - `guideQuality`: writing problems that make the guide sound wrong. These block `ready`.
   - `otherWarnings`: preview warnings such as `DUPLICATE_IN_PACKAGE` (also blocks `ready`).
   - `authoring`: meaning checks (dates without a year, ended runs, runs that end within three
     weeks, statuses and relative dates without a date, placeholder facts, conflicting lines,
     repeated cautions, near-duplicate topics, facts in voice notes). Advice: they never block an
     import, but fix each one or be able to say why it is a false positive.
   - `venueSetup`: settings to fix before testing answers (time zone, guide mode).
     Fix and check again until `ready` is true.
   - Before a venue exists, run the same schema, writing-guide and authoring checks offline from
     a repository checkout: `pnpm venue:check <package.json> --official-domain <venue domain>`.
     It also lists source hosts and flags sources off the official domain. It cannot see the
     venue's existing records or settings, so `venues.check_package` is still required.
   - A second package for a venue that already has records needs those records' search
     embeddings first. Until the venue embedding refresh runs (an operator step in the Torchiko
     runbook, not an MCP tool), `errors` holds `SEMANTIC_SCAN_INCOMPLETE` and the import would be
     refused with nothing changed. Ask the operator for the venue-scoped refresh, then check
     again. The existing refresh requires an active venue; it does not work on an unpublished
     draft. Publish only with the owner's authorization and only after gate 2 passes; until
     then leave the package unapplied. Keep global
     worker flags unchanged. A successful check is not proof that embeddings are current for
     every record: it checks only the existing records relevant to this package's duplicate scan.
3. **Import (a write).** `venues.propose_package_import` with the same package and a new UUID
   `operationId`. In this deployment the write applies in the same call: status `APPLIED` means
   the venue's records changed. `FAILED` or `STALE` means nothing changed for a validation error;
   for any other failure, follow "Import recovery" in the full manual before sending anything else.
   Under `OPERATOR_APPROVAL_MODE=review` the status is `PENDING` until a person decides; a pending
   proposal has changed nothing.
4. **Publish.** Applied records are visible to visitors only once the venue is published.
   `venues.propose_publish` makes a draft venue visible and returns `publicUrl`. A published venue
   shows an applied import at once.
5. **Confirm.** `venues.get_guest_link` returns `usable` and the blockers. Then ask the guide the
   self-test questions in the manual ("Self-test before you hand a venue over").

Words: a **preview** is a check that saved nothing; a **proposal** is the record of a write call
(`proposalId`, `status`); **applied** means the venue data changed; **published** means visitors
can open the guide. Replaying the same `operationId` with the same content returns the same
receipt and never applies twice.

## Which version

Use `"schemaVersion": 3` for every new package. It is the only version that records provenance
for each record and the only one that can update or retire existing records. Versions 1 and 2 still
import for older tools.

A version 3 package has `places` and `knowledgeEntries`, each an object with optional `create`,
`update` and `delete` lists, plus an optional `venue` patch. Every operation has:

- `itemKey`: a new UUID for this operation (unique in the package);
- `provenance`: `sourceType` (required, for example `official_website`, `venue_staff`,
  `printed_map`), `contentOrigin` (required: `HUMAN_AUTHORED` or `AI_GENERATED`), and optional
  `sourceName` and credential-free `sourceUrl`;
- `value`: the record for `create` and `update`. `update` and `delete` also take the existing
  record `id`; `delete` has no `value` field.

A `create` value may leave out optional fields. An `update` value is the record's complete desired
state: every field, with `null` for an empty one, and `isActive` or `isEnabled`. To retire a place
that other data refers to, update it with `"isActive": false` rather than deleting it.

Required, defaults and optional fields are listed in `schema`. Unknown fields are rejected, never
ignored, so research notes cannot slip into a record by accident.

## Where each kind of information belongs

| Information                                                       | Where it goes                                                                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A place a visitor can go to (ride, exhibit, restaurant, restroom) | One place record. First sentence says what it is. Its own facts are labeled lines in `longDescription`: `Height:`, `Price:`, `Hours:`, `Also called:` |
| A place's opening times when they differ from the venue           | That place's `hours` field (days and times only)                                                                                                      |
| Venue hours and season                                            | One knowledge topic, "Hours and season", every day and date range with its year                                                                       |
| Ticket prices, passes, discounts                                  | One "Tickets and prices" topic; a per-place charge also goes on that place's `Price:` line                                                            |
| Policies (bags, pets, re-entry, smoking, accessibility)           | One topic per policy. Never the same policy in two topics                                                                                             |
| Category lists (every ride, every place to eat)                   | One overview topic per category naming every member by its exact record name                                                                          |
| Events and seasonal programs                                      | One topic per event, with dates and year in the text (see "Changing information")                                                                     |
| Weather and safety protocols                                      | One topic per protocol, with no date: it always applies                                                                                               |
| A closure or change happening now                                 | Not a package: `venues.propose_operational_update` with a start and end                                                                               |
| Area groupings                                                    | `areaName` on each place, and a "Planning by area" topic                                                                                              |
| Venue description, guide name, tone preset, AI guide notes        | `venue` patch (`identity`, `aiBehavior`) or `venues.propose_update`                                                                                   |
| Time zone, theme, accent                                          | Not a package: `appearance.propose_update` (`chatAppearance.timeZone` is required for hours answers)                                                  |
| Ticket, pass and booking links                                    | Not a package: `appearance.propose_guest_actions`                                                                                                     |
| Visitor chat model                                                | Not a package: `venues.get_guest_model` and `venues.propose_guest_model`                                                                              |
| Sources                                                           | `provenance` on each operation. Never in record text                                                                                                  |
| Research notes, conflicts, checked-on dates, confidence           | Nowhere in the package. Keep your own source ledger                                                                                                   |

## How records connect

Records are linked by names, not by ids:

- A category overview names each member exactly as its record is named. `check_package` reports an
  overview that misses a record of its kind (`GUIDE_QUALITY_OVERVIEW_COVERAGE`).
- `areaName` groups places, and the "Planning by area" topic uses the same area names.
- When one thing has several records (a ship, its exhibit, its pavilion), each first sentence says
  which part it covers and names the others.

There are no relationship, parent or audience fields. Do not invent them.

### Keep list facts on the member too

An overview helps answer lists; each member's own record must also answer questions about that
member. Write `Juniper Grill — restaurant in East Mall.` on one overview line, and put
`Juniper Grill is a restaurant in East Mall.` on the grill's own record (or use its `areaName`).
Do not split the overview into `Juniper Grill — restaurant.` followed by `East Mall.` on a new line.

Two authoring advisories help catch these mistakes. They never block `ready` or import:

- `MEMBER_FACT_ONLY_IN_OVERVIEW` identifies a clearly attributed location on a dash-separated
  overview entry that is absent from the matching member's own text or `areaName`. Add the
  verified location to that record. If the record expresses the same location differently,
  justify the finding instead of duplicating text.
- `BROKEN_LIST_LINE` identifies a detached location fragment following a dash-separated member
  in an overview. Join the member, kind and location on one line.

These are conservative checks of overview topics and exact member names, not a completeness or
fact-checking guarantee. They do not compare hours or prices, infer unnamed places, or reliably
recognize every paraphrase, prose list or arbitrary area name. Review unflagged lists too.

Keep cautions useful and specific: explain what varies and what a visitor should do. Remove
repeated generic instructions to confirm everything, but keep necessary allergy, access and
safety advice. There is no automatic caution-count threshold: frequency alone did not reliably
separate excessive disclaimers from useful instructions in the evaluated corpus.

## Unknown, conflicting, seasonal and incomplete information

- **Unknown.** Leave the fact out. Never fill a required field or a labeled line with a guess or a
  placeholder (`Price: TBD`). If visitors need to know something is unconfirmed, say it once in
  visitor terms: "Ask at the grill counter about nut cross-contact before ordering."
- **Conflicting sources.** Verify the facts against the authoritative source before choosing one;
  never invent a stricter or looser safety rule. Keep the conflict in your ledger. If unresolved,
  state the uncertainty and direct visitors to staff. If the true answer varies, say how it varies
  ("Hours can change on holiday weekends; Guest Services has the day's hours").
- **Seasonal and recurring.** Always write the year. When a season has ended, say so and say what is
  known about the next one: "The 2026 season ended September 7. 2027 dates are not announced yet."
  Never invent next year's dates.
- **Incomplete.** Import what is verified. A smaller correct guide answers better than a complete
  guessed one. Missing whole categories can be added later with another version 3 package.
- **Statuses.** "Closed for the season", "temporarily closed" and "under renovation" are true only
  for a while, and package records never expire. Date them ("Closed for the 2026 season after
  October 25, 2026") or use `venues.propose_operational_update` (`UNDATED_STATUS`). Never write
  "next year", "this fall" or "tomorrow" (`RELATIVE_DATE`).
- **Runs about to end.** A record whose last date passes within three weeks (`EXPIRES_SOON`) will
  read as current after that day. Import it only with a planned update, or write what stays true.
- **Talk about the place, not the record or the source.** The guide repeats record text to
  visitors. "The rides covered here are", "no date is confirmed here", "its page carries a notice"
  and "some linked menus are summer menus" are rejected by the writing guide. Say the fact, or say
  plainly what a visitor should ask staff.
- **The right venue.** Two venues can share a name in different cities. Every source must be the
  target venue's own site or a source that names its city. A package records facts only for the
  venue it will be imported into.

## Changing information

Today the guide reads dates from record text, and the server computes only the venue's local date,
weekday and time (from `chatAppearance.timeZone`). Write every date with its month name, day and
year; check_package flags dates without a year (`UNDATED_SEASON`), numeric dates such as 10/11
(`AMBIGUOUS_DATE`) and runs that have ended but read as current (`STALE_DATE`). Use
`venues.propose_operational_update` for live closures and changed hours. A weather protocol is a
normal topic with no dates.

**Planned, not available:** a structured `schedule` block on records (events, daily show times,
seasons, with computed "on today / starts on / ended" status lines) and a flag-gated "closed today"
cue. Packages that include `schedule`, `startDate` or `endDate` are rejected today. Keep writing
dates in text; that text stays valid when schedules arrive.

## Voice and length

Voice settings change how answers sound, never what they say. Facts come only from records; the
prompt places every voice setting below the platform's factual and safety rules.

- `tonePreset`: `friendly`, `concise`, `enthusiastic` or `informative`.
- `responseDepth`: `BRIEF` (about 45 words; 100 when the visitor asks for more or a comparison),
  `BALANCED` (about 90 words; 150) or `DETAILED` (about 130 words; 200). New guides start at `BRIEF`. Restrictions,
  exceptions and uncertainty are always kept, even when that needs a few more words.
- `aiGuideName` and `greeting`: the guide's name and first line.
- `aiGuideNotes`: short behavior notes ("Call the dinosaurs by their nicknames"; "Never use
  exclamation marks"). Never put facts here (`FACT_IN_VOICE_NOTES`): a price or time in voice notes
  is not dated, checked or shown with its source.

Set them with `venues.propose_update` (or the `venue.aiBehavior` patch). Custom personality sliders
are not available through the MCP.

## Complete example

A fictional park. Its time zone (`America/Chicago`) is set separately with
`appearance.propose_update`. Generate fresh `itemKey` UUIDs for real packages.

<!-- venue-authoring-example:complete -->

```json
{
  "schemaVersion": 3,
  "venue": {
    "identity": {
      "description": "Quillbrook Fun Park is a small family amusement park with rides, a splash pad and a lakeside grill."
    },
    "aiBehavior": { "tonePreset": "friendly", "aiGuideName": "Quill" }
  },
  "places": {
    "create": [
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a01",
        "provenance": {
          "sourceType": "official_website",
          "sourceName": "Quillbrook ride guide",
          "sourceUrl": "https://example.org/rides",
          "contentOrigin": "AI_GENERATED"
        },
        "value": {
          "name": "Comet Chaser",
          "type": "family roller coaster",
          "itemType": "activity",
          "shortDescription": "Comet Chaser is a family roller coaster in the Starfield area.",
          "longDescription": "Comet Chaser is a family roller coaster in the Starfield area with small drops and quick turns, and riders sit two by two.\nHeight: 42 in to ride; 36 in with an adult",
          "areaName": "Starfield",
          "lat": 41.5012,
          "lng": -90.5134,
          "importanceScore": 80
        }
      },
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a02",
        "provenance": {
          "sourceType": "official_website",
          "sourceName": "Quillbrook ride guide",
          "contentOrigin": "AI_GENERATED"
        },
        "value": {
          "name": "Lily Pad Leap",
          "type": "drop ride",
          "itemType": "activity",
          "shortDescription": "Lily Pad Leap is a small frog-hopper drop ride in the Marsh area.",
          "longDescription": "Lily Pad Leap is a small frog-hopper drop ride in the Marsh area that bounces riders up and down a short tower.\nHeight: 36 in to ride",
          "areaName": "Marsh",
          "lat": 41.5007,
          "lng": -90.5121,
          "importanceScore": 50
        }
      },
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a03",
        "provenance": {
          "sourceType": "printed_map",
          "sourceName": "2026 park map",
          "contentOrigin": "HUMAN_AUTHORED"
        },
        "value": {
          "name": "Hollow Log Grill",
          "type": "counter-service restaurant",
          "itemType": "amenity",
          "shortDescription": "Hollow Log Grill is a counter-service restaurant by the lake in the Marsh area.",
          "longDescription": "Hollow Log Grill is a counter-service restaurant by the lake in the Marsh area serving burgers, grilled cheese and fries.\nMenu: burgers, grilled cheese, chicken strips, fries, lemonade",
          "areaName": "Marsh",
          "hours": "11am-6pm on park days",
          "lat": 41.5003,
          "lng": -90.5117,
          "importanceScore": 60
        }
      }
    ]
  },
  "knowledgeEntries": {
    "create": [
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a11",
        "provenance": {
          "sourceType": "official_website",
          "sourceName": "Quillbrook hours page",
          "contentOrigin": "AI_GENERATED"
        },
        "value": {
          "title": "Hours and season",
          "category": "Visiting",
          "content": "Quillbrook Fun Park is open Tuesday to Sunday during its summer season and closed on Mondays.\nHours: 10am-7pm Tuesday to Sunday, May 23 to September 7, 2026\nClosed: Mondays\nThe 2026 season ended September 7, 2026. 2027 dates are not announced yet."
        }
      },
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a12",
        "provenance": {
          "sourceType": "official_website",
          "sourceName": "Quillbrook tickets page",
          "contentOrigin": "AI_GENERATED"
        },
        "value": {
          "title": "Tickets and prices",
          "category": "Visiting",
          "content": "A day ticket covers every ride and the splash pad.\nPrice: $32 for a day ticket in the 2026 season; children under 3 enter free"
        }
      },
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a13",
        "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" },
        "value": {
          "title": "Rides overview",
          "category": "Rides",
          "content": "Quillbrook has two rides: Comet Chaser, a family roller coaster in Starfield, and Lily Pad Leap, a small drop ride in Marsh."
        }
      },
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a14",
        "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" },
        "value": {
          "title": "Dining overview",
          "category": "Dining",
          "content": "Quillbrook has one place to eat: Hollow Log Grill, a counter-service restaurant by the lake in Marsh."
        }
      },
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a15",
        "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" },
        "value": {
          "title": "Rides by height",
          "category": "Planning",
          "content": "Children 36 in and taller can ride Lily Pad Leap. Children 42 in and taller can ride Comet Chaser alone, and children 36 to 41 in can ride it with an adult."
        }
      },
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a16",
        "provenance": {
          "sourceType": "official_website",
          "sourceName": "Quillbrook events page",
          "contentOrigin": "AI_GENERATED"
        },
        "value": {
          "title": "Lantern Nights",
          "category": "Events",
          "content": "Lantern Nights is an evening holiday light walk around the lake with cocoa stands and carolers.\nDates: Fridays and Saturdays, November 27 to December 19, 2026, 5pm-9pm\nPrice: included with a day ticket"
        }
      },
      {
        "itemKey": "0d6c9a52-3f0e-4b7a-9a51-6f1d2c3b4a17",
        "provenance": { "sourceType": "venue_staff", "contentOrigin": "HUMAN_AUTHORED" },
        "value": {
          "title": "Severe weather",
          "category": "Safety",
          "content": "Rides pause when lightning is within 10 miles and restart 30 minutes after the last strike. Guests can wait in the covered pavilion next to Hollow Log Grill."
        }
      }
    ]
  }
}
```

## Hard cases

A recurring event whose next dates are not known. Do not drop it and do not guess its dates:

<!-- venue-authoring-example:recurring-event -->

```json
{
  "schemaVersion": 3,
  "places": {},
  "knowledgeEntries": {
    "create": [
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e21",
        "provenance": {
          "sourceType": "official_website",
          "sourceName": "Quillbrook events page",
          "contentOrigin": "AI_GENERATED"
        },
        "value": {
          "title": "Pumpkin Days",
          "category": "Events",
          "content": "Pumpkin Days is a fall festival with a corn maze, hayrides and pumpkin picking.\nThe 2026 festival ended October 25, 2026. It returns each fall, and 2027 dates are not announced yet."
        }
      }
    ]
  }
}
```

Sources disagree, and one fact is unknown. State the best-supported fact once and the real
uncertainty once, in visitor terms:

<!-- venue-authoring-example:conflict-and-unknown -->

```json
{
  "schemaVersion": 3,
  "places": {},
  "knowledgeEntries": {
    "create": [
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e31",
        "provenance": {
          "sourceType": "official_website",
          "sourceName": "Quillbrook dining page",
          "contentOrigin": "AI_GENERATED"
        },
        "value": {
          "title": "Food allergies",
          "category": "Dining",
          "content": "Hollow Log Grill can make burgers without cheese and serves gluten-free buns on request. Ask at the grill counter about nut and sesame cross-contact before ordering."
        }
      }
    ]
  }
}
```

Correct an existing place and retire another. An update carries the complete desired state;
`isActive: false` retires a place without losing its history:

<!-- venue-authoring-example:update-and-retire -->

```json
{
  "schemaVersion": 3,
  "places": {
    "update": [
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e41",
        "id": "cm2examplecomet0001",
        "provenance": { "sourceType": "venue_staff", "contentOrigin": "HUMAN_AUTHORED" },
        "value": {
          "name": "Comet Chaser",
          "type": "family roller coaster",
          "itemType": "activity",
          "shortDescription": "Comet Chaser is a family roller coaster in the Starfield area.",
          "longDescription": "Comet Chaser is a family roller coaster in the Starfield area with small drops and quick turns, and riders sit two by two.\nHeight: 44 in to ride; 38 in with an adult",
          "lat": 41.5012,
          "lng": -90.5134,
          "tags": [],
          "importanceScore": 80,
          "areaName": "Starfield",
          "hours": null,
          "photoUrl": null,
          "isActive": true
        }
      },
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e42",
        "id": "cm2examplepond0002",
        "provenance": { "sourceType": "venue_staff", "contentOrigin": "HUMAN_AUTHORED" },
        "value": {
          "name": "Paddle Boats",
          "type": "boat rental",
          "itemType": "activity",
          "shortDescription": "Paddle Boats is a pedal boat rental on the lake.",
          "longDescription": null,
          "lat": null,
          "lng": null,
          "tags": [],
          "importanceScore": 0,
          "areaName": null,
          "hours": null,
          "photoUrl": null,
          "isActive": false
        }
      }
    ]
  },
  "knowledgeEntries": {}
}
```

## Common mistakes and what check_package says

Research notes and an unsupported field. Rejected with `UNKNOWN_FIELD` and a fix for each key:

<!-- venue-authoring-mistake:research-fields expect=UNKNOWN_FIELD -->

```json
{
  "schemaVersion": 1,
  "places": [
    {
      "name": "Comet Chaser",
      "type": "roller coaster",
      "latitude": 41.5,
      "longitude": -90.5,
      "notes": "two sources disagree on height"
    }
  ],
  "knowledgeEntries": []
}
```

Placeholder facts, a date without a year and a numeric date. Accepted, with `authoring` advice
(`PLACEHOLDER_FACT`, `UNDATED_SEASON`, `AMBIGUOUS_DATE`):

<!-- venue-authoring-mistake:placeholders expect=PLACEHOLDER_FACT,UNDATED_SEASON,AMBIGUOUS_DATE -->

```json
{
  "schemaVersion": 3,
  "places": {},
  "knowledgeEntries": {
    "create": [
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e51",
        "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" },
        "value": {
          "title": "Hours and season",
          "category": "Visiting",
          "content": "Quillbrook Fun Park is open daily in summer.\nHours: 10am-7pm daily, May 23 to September 7\nPrice: TBD\nThe park closes early on 7/4 for fireworks."
        }
      }
    ]
  }
}
```

Facts in voice notes and the same caution copied into several records (`FACT_IN_VOICE_NOTES`,
`REPEATED_TEXT`): see the `authoring` findings and move each fact to its one topic.

A status with no date and a relative date. Accepted, with `authoring` advice (`UNDATED_STATUS`,
`RELATIVE_DATE`):

<!-- venue-authoring-mistake:undated-status expect=UNDATED_STATUS,RELATIVE_DATE -->

```json
{
  "schemaVersion": 3,
  "places": {},
  "knowledgeEntries": {
    "create": [
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e61",
        "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" },
        "value": {
          "title": "Splash Pad",
          "category": "Attractions",
          "content": "Splash Pad is a shallow water-play area in the Marsh area, closed for the season."
        }
      },
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e62",
        "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" },
        "value": {
          "title": "Pumpkin Days",
          "category": "Events",
          "content": "Pumpkin Days is a fall festival with a corn maze. It returns next year."
        }
      }
    ]
  }
}
```

A record that talks about itself and its source page. Rejected by the writing guide
(`GUIDE_QUALITY_RECORD_VOICE`, `GUIDE_QUALITY_SOURCE_NARRATION`):

<!-- venue-authoring-mistake:record-talk expect=GUIDE_QUALITY_RECORD_VOICE,GUIDE_QUALITY_SOURCE_NARRATION -->

```json
{
  "schemaVersion": 3,
  "places": {},
  "knowledgeEntries": {
    "create": [
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e71",
        "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" },
        "value": {
          "title": "Rides overview",
          "category": "Rides",
          "content": "The rides covered here are Comet Chaser, a family roller coaster, and Lily Pad Leap, a drop ride."
        }
      },
      {
        "itemKey": "5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e72",
        "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" },
        "value": {
          "title": "Marsh Train",
          "category": "Rides",
          "content": "Marsh Train is a narrated train ride around the lake. Its page carries an old closure notice."
        }
      }
    ]
  }
}
```
