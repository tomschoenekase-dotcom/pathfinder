# Venue package JSON format

- Status: authoritative operator reference for the current dashboard importer
- Runtime authority: `packages/api/src/schemas/venue-package.ts`
- Supported schema versions: `1`, `2`, and `3`
- Current latest version: `3`

PathFinder venue packages are strict JSON documents used by the dashboard's **Venue package
workspace**. Previewing a package is read-only. Saving, approving, applying, and reverting are
separate authenticated lifecycle actions; pasting JSON never writes venue content by itself.
Managers and owners can preview and save drafts. Only owners can approve, apply, or revert them.

This document describes the accepted input payload. It does not describe stored previews,
validation reports, or applied-effect manifests, which are server-produced evidence.

## Common rules

- Include `schemaVersion`; omitted and unsupported versions are rejected.
- Objects are strict. Unknown keys at the root or inside nested objects are rejected rather than
  ignored.
- A package can contain at most **500** total places and knowledge entries in V1/V2, or 500 total
  create/update/delete operations in V3. Venue configuration fields do not consume this limit.
- V1/V2 coordinates must provide both `lat` and `lng` or neither. V3 desired state uses both values
  together, either as two numbers or two `null` values.
- For a `location_aware` venue, server preview additionally requires coordinates on every new
  place. An active V3 place update must also retain coordinates. Non-location venues may omit new
  coordinates, and inactive V3 desired state may use a null coordinate pair.
- `itemType` is optional and is independent of the venue's guide mode. Accepted values are
  `physical_place`, `exhibit`, `room`, `sculpture`, `service_step`, `faq`, `amenity`, `policy`,
  `activity`, and `general_info`; an empty string is normalized as omitted.
- No schema version accepts audience, venue-archetype, tour, assistant-experience, or capability
  fields. Do not encode access policy in package JSON. Restricted content will require a separate,
  explicit authorization design that denies access before retrieval or model ingress.
- Always use the server preview shown in the dashboard as the exact change plan. A structurally
  valid package may still produce duplicate, dependency, stale-version, or other validation
  findings.

## Shared content fields

### Place create fields (V1, V2, and V3 create)

| Field              | Required | Accepted value                                                          |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `name`             | yes      | non-empty string, at most 200 characters                                |
| `type`             | yes      | non-empty string                                                        |
| `itemType`         | no       | one of the common-rule values above                                     |
| `shortDescription` | no       | string, at most 500 characters                                          |
| `longDescription`  | no       | string, at most 2,000 characters                                        |
| `lat` / `lng`      | no       | latitude -90..90 and longitude -180..180; supply together               |
| `tags`             | no       | string array; defaults to `[]`                                          |
| `importanceScore`  | no       | integer 0..100; defaults to `0`                                         |
| `areaName`         | no       | string, at most 200 characters                                          |
| `hours`            | no       | string, at most 200 characters                                          |
| `photoUrl`         | no       | URL, at most 2,000 characters; an empty string is normalized as omitted |

### Knowledge-entry create fields (all versions)

| Field       | Required | Accepted value                             |
| ----------- | -------- | ------------------------------------------ |
| `title`     | yes      | non-empty string, at most 200 characters   |
| `category`  | yes      | non-empty string, at most 100 characters   |
| `content`   | yes      | non-empty string, at most 5,000 characters |
| `isEnabled` | no       | boolean; defaults to `true`                |

## V1: frozen additive content

Use V1 to add places and knowledge without changing existing records or venue configuration. At
least one place or knowledge entry is required. V1 is frozen for compatibility; new mutation
capabilities belong in a later version.

<!-- venue-package-example:v1 -->

```json
{
  "schemaVersion": 1,
  "places": [
    {
      "name": "Butterfly gallery",
      "type": "gallery",
      "itemType": "exhibit",
      "shortDescription": "A walkthrough habitat.",
      "lat": 41.881,
      "lng": -87.623,
      "tags": ["family"],
      "importanceScore": 70
    }
  ],
  "knowledgeEntries": [
    {
      "title": "Accessibility entrance",
      "category": "Accessibility",
      "content": "Step-free entry is available at the east entrance.",
      "isEnabled": true
    }
  ]
}
```

## V2: venue configuration patch plus additive content

V2 adds an optional `venue` patch while retaining V1's additive `places` and
`knowledgeEntries`. An omitted field means **no change**. A supported nullable field set to `null`
means **clear the current value**. The two content arrays may be omitted and default to empty.
Include at least one venue field, place, or knowledge entry.

`venue` accepts:

- `identity`: `name` (1..200 characters), `description` (up to 1,000 or `null`), and `category`
  (up to 100 or `null`).
- `guideNotes`: up to 2,000 characters or `null`.
- `branding`: `chatTheme` (`default`, `forest`, `sunset`, `midnight`, `rose`, or `dark`),
  `chatAccentColor` (`#RRGGBB`), `chatFont` (`jakarta`, `inter`, `poppins`, `spaceGrotesk`,
  `dmSans`, or `playfair`), `chatLogoUrl`, and `chatBannerUrl`. Every field is nullable; URLs are
  limited to 500 characters. URLs are references only; the package does not upload or host assets.
- `aiBehavior`: `aiGuideNotes` (up to 2,000 characters), `aiTone` (`FRIENDLY`, `PROFESSIONAL`, or
  `PLAYFUL`), and `aiGuideName` (up to 80 characters). Every field is nullable.

Each included nested patch object must contain at least one field.

<!-- venue-package-example:v2 -->

```json
{
  "schemaVersion": 2,
  "venue": {
    "identity": {
      "description": "A hands-on science museum."
    },
    "branding": {
      "chatTheme": "forest",
      "chatBannerUrl": null
    },
    "aiBehavior": {
      "aiTone": "FRIENDLY"
    }
  },
  "places": [],
  "knowledgeEntries": []
}
```

## V3: explicit create, update, and delete operations

V3 retains the optional V2 venue patch and replaces additive arrays with operation groups. It is
the only version that updates or deletes existing places and knowledge entries.

Every operation requires a newly generated UUID `itemKey` that is unique within the package and a
`provenance` object. Update and delete operations also require the existing entity's CUID `id`. The
same existing entity cannot be targeted more than once in one package. The `places` and
`knowledgeEntries` groups are required; their `create`, `update`, and `delete` arrays may be omitted
and default to empty.

`provenance` contains:

- required `sourceType` (1..64 characters);
- optional `sourceName` (1..200 characters);
- optional credential-free HTTP(S) `sourceUrl` (at most 2,000 characters); and
- required `contentOrigin`, either `HUMAN_AUTHORED` or `AI_GENERATED`.

Never put credentials, tokens, signatures, passwords, or signed-storage query parameters in
`sourceUrl`; credential-bearing, non-HTTP(S), and percent-encoded query or fragment values are
rejected.

V3 create `value` objects use the shared create fields above. V3 update `value` objects are complete
desired states, not partial patches:

- A place update requires `name`, `type`, `itemType` as a string or `null`, nullable descriptions,
  nullable coordinate pair, `tags`, `importanceScore`, nullable `areaName`, `hours`, and `photoUrl`,
  plus `isActive`. Unlike create input, update desired state accepts legacy `itemType` strings so
  the full existing record can be represented safely.
- A knowledge update requires `title`, `category`, `content`, and `isEnabled`.

At least one venue field or content operation is required.

<!-- venue-package-example:v3 -->

```json
{
  "schemaVersion": 3,
  "places": {
    "create": [
      {
        "itemKey": "00000000-0000-4000-8000-000000000001",
        "provenance": {
          "sourceType": "curated-notes",
          "sourceName": "Visitor services handbook",
          "sourceUrl": "https://example.com/visitor-services",
          "contentOrigin": "HUMAN_AUTHORED"
        },
        "value": {
          "name": "Quiet room",
          "type": "amenity",
          "itemType": "amenity",
          "tags": ["accessibility"],
          "importanceScore": 80
        }
      }
    ],
    "update": [
      {
        "itemKey": "00000000-0000-4000-8000-000000000002",
        "provenance": {
          "sourceType": "curated-notes",
          "contentOrigin": "HUMAN_AUTHORED"
        },
        "id": "cm00000000000000000000001",
        "value": {
          "name": "Main gallery",
          "type": "gallery",
          "itemType": "room",
          "shortDescription": "The primary exhibition space.",
          "longDescription": null,
          "lat": null,
          "lng": null,
          "tags": ["featured"],
          "importanceScore": 90,
          "areaName": "First floor",
          "hours": null,
          "photoUrl": null,
          "isActive": true
        }
      }
    ],
    "delete": []
  },
  "knowledgeEntries": {
    "create": [],
    "update": [],
    "delete": [
      {
        "itemKey": "00000000-0000-4000-8000-000000000003",
        "provenance": {
          "sourceType": "content-audit",
          "contentOrigin": "HUMAN_AUTHORED"
        },
        "id": "cm00000000000000000000002"
      }
    ]
  }
}
```

## Safe operator workflow

1. Select the target venue in the dashboard and paste the complete JSON document.
2. Choose **Preview on server**. Resolve all structural, exact-duplicate, dependency, location, and
   stale-history findings, then review the exact change plan. Semantic duplicate status is
   `NOT_RUN` at this read-only preview stage.
3. Save an immutable draft. Saving performs semantic duplicate analysis and returns the stored
   evidence. Review the stored draft again, including all exact and semantic warnings. An
   incomplete semantic scan cannot be approved or applied. Re-preview and save a new draft if the
   source JSON or venue state changes.
4. An authorized owner separately acknowledges the stored payload hash and combined warning digest
   and approves the draft.
5. An authorized owner applies the approved package as a separate action. Application is atomic and
   rejects stale venue or entity state rather than silently overwriting it.
6. If necessary, an authorized owner uses the package's confirmed revert action. Revert is
   conflict-aware; later content changes can make an automatic revert unsafe and therefore
   rejected.

Draft and lifecycle commands use idempotency keys, but operators should rely on the dashboard rather
than constructing API calls manually. Keep the original JSON and the server-produced preview as
review evidence.

## Change control

The Zod schemas are runtime authority. Changes to accepted fields, bounds, defaults, or semantics
must update this document and its contract test in the same commit. Never loosen V1 in place; add a
new discriminated schema version for incompatible behavior.
