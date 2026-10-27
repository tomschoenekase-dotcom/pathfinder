import type { z } from 'zod'

/**
 * Turns venue-package schema issues into agent-facing errors: the exact field, what is wrong, and a
 * valid correction. The schema itself stays the only definition of what is accepted
 * (packages/api/src/schemas/venue-package.ts); this module only explains its refusals.
 */
export type PackageIssue = {
  code: string
  path: string
  message: string
  fix: string
  example?: string
}

type Issue = z.core.$ZodIssue

const ITEM_TYPES =
  'physical_place, exhibit, room, sculpture, service_step, faq, amenity, policy, activity, general_info'

/** Keys agents commonly invent, with where that information actually belongs. */
const MISPLACED_KEYS: Readonly<Record<string, { fix: string; example?: string }>> = {
  latitude: {
    fix: 'Coordinates are the numbers lat and lng on the place, given together.',
    example: '"lat": 42.4651, "lng": -92.342',
  },
  longitude: {
    fix: 'Coordinates are the numbers lat and lng on the place, given together.',
    example: '"lat": 42.4651, "lng": -92.342',
  },
  coordinates: {
    fix: 'Coordinates are the numbers lat and lng on the place, given together.',
    example: '"lat": 42.4651, "lng": -92.342',
  },
  location: {
    fix: 'Use lat and lng numbers for the pin and areaName for the visitor-facing area.',
    example: '"areaName": "North Garden", "lat": 42.4651, "lng": -92.342',
  },
  description: {
    fix: 'Places use shortDescription (up to 500 characters) and longDescription (up to 2,000).',
    example: '"shortDescription": "Cinderswing is a swinging pendulum ride in the Ember area."',
  },
  sourceUrl: {
    fix: 'Source links are provenance, not record fields. Use schemaVersion 3, where every create, update and delete operation carries provenance.sourceUrl and provenance.sourceName.',
    example:
      '"provenance": { "sourceType": "official_website", "sourceName": "Venue website", "sourceUrl": "https://example.org/visit", "contentOrigin": "AI_GENERATED" }',
  },
  sourceName: {
    fix: 'Source names are provenance, not record fields. Use schemaVersion 3 and put it in provenance.sourceName on the operation.',
    example:
      '"provenance": { "sourceType": "official_website", "sourceName": "Venue website", "contentOrigin": "AI_GENERATED" }',
  },
  source: {
    fix: 'Sources are provenance. Use schemaVersion 3 and put them in the operation provenance object.',
    example:
      '"provenance": { "sourceType": "official_website", "sourceName": "Venue website", "contentOrigin": "AI_GENERATED" }',
  },
  sources: {
    fix: 'A package carries one provenance object per operation (schemaVersion 3). Keep a longer source ledger outside the package.',
  },
  notes: {
    fix: 'Packages have no research-notes field and every text field reaches visitors. Keep research notes, conflicts and checked-on dates in your own ledger, outside the package.',
  },
  researchNotes: {
    fix: 'Packages have no research-notes field and every text field reaches visitors. Keep research notes in your own ledger, outside the package.',
  },
  internalNotes: {
    fix: 'Packages have no internal-notes field and every text field reaches visitors. Keep internal notes outside the package.',
  },
  confidence: {
    fix: 'Packages have no confidence field. Leave unconfirmed facts out, or state the uncertainty once in visitor terms ("Ask at the front desk about ...").',
  },
  schedule: {
    fix: 'Structured schedule blocks are planned but not available yet. Write dates in the record text with the year ("Runs Fridays to Sundays, September 25 to October 31, 2026"); use venues.propose_operational_update for live closures.',
  },
  startDate: {
    fix: 'Structured dates are not available yet. Write the full date with its year in the record text.',
    example:
      '"content": "Lantern Nights runs Fridays and Saturdays, November 27 to December 19, 2026."',
  },
  endDate: {
    fix: 'Structured dates are not available yet. Write the full date with its year in the record text.',
    example:
      '"content": "Lantern Nights runs Fridays and Saturdays, November 27 to December 19, 2026."',
  },
  price: {
    fix: 'Prices are a labeled line in the record text, not a field.',
    example: '"content": "... \\nPrice: $5 per play"',
  },
  height: {
    fix: 'Height rules are a labeled line in the record text, not a field.',
    example: '"longDescription": "... \\nHeight: 48 in to ride; 36 in with an adult"',
  },
  audience: {
    fix: 'No schema version accepts audience or access fields. All package content is visitor-facing.',
  },
  body: {
    fix: 'Knowledge entries use content for their text.',
    example: '"content": "Parking is free in the main lot off Ridge Road."',
  },
  text: {
    fix: 'Knowledge entries use content for their text.',
    example: '"content": "Parking is free in the main lot off Ridge Road."',
  },
  name: {
    fix: 'Knowledge entries use title (a name such as "Parking"), not name.',
    example: '"title": "Parking"',
  },
  title: {
    fix: 'Places use name, not title.',
    example: '"name": "Cinderswing"',
  },
  id: {
    fix: 'New records have no id. Only schemaVersion 3 update and delete operations take the existing record id (venues.list_content with representation LEGACY_PLACE or LEGACY_KNOWLEDGE).',
  },
}

function pathText(path: readonly PropertyKey[]): string {
  return path.map((part) => String(part)).join('.')
}

function valueAt(payload: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = payload
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[part]
  }
  return current
}

function quote(value: unknown): string {
  const text =
    typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'missing')
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

function lastKey(path: readonly PropertyKey[]): string {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (typeof path[index] === 'string') return path[index] as string
  }
  return ''
}

/** "places.create.0.value" -> "a place", for wording only. */
function owner(path: readonly PropertyKey[]): string {
  const text = pathText(path)
  if (text.startsWith('places')) return 'place'
  if (text.startsWith('knowledgeEntries')) return 'knowledge entry'
  if (text.startsWith('venue')) return 'venue patch'
  return 'package'
}

function unrecognized(issue: Extract<Issue, { code: 'unrecognized_keys' }>): PackageIssue[] {
  const where = owner(issue.path)
  return issue.keys.map((key) => {
    const known =
      key === 'description' && where === 'knowledge entry'
        ? MISPLACED_KEYS.body
        : MISPLACED_KEYS[key]
    // A place legitimately has name and a knowledge entry title; only flag the swapped one.
    const swapped =
      (key === 'name' && where !== 'knowledge entry') || (key === 'title' && where !== 'place')
    return {
      code: 'UNKNOWN_FIELD',
      path: pathText([...issue.path, key]),
      message: `"${key}" is not a field of a ${where}. Unknown fields are rejected, never ignored.`,
      fix:
        known && !swapped
          ? known.fix
          : 'Remove it, or move the information into a supported field. operator.get_manual with section "venue-authoring" lists every field (schema).',
      ...(known?.example && !swapped ? { example: known.example } : {}),
    }
  })
}

function invalidValue(
  issue: Extract<Issue, { code: 'invalid_value' }>,
  payload: unknown,
): PackageIssue {
  const allowed = issue.values.map((value) => JSON.stringify(value)).join(', ')
  return {
    code: 'NOT_ALLOWED_VALUE',
    path: pathText(issue.path),
    message: `${quote(valueAt(payload, issue.path))} is not an allowed value.`,
    fix: `Use one of: ${allowed}.`,
  }
}

function union(issue: Extract<Issue, { code: 'invalid_union' }>, payload: unknown): PackageIssue {
  const path = pathText(issue.path)
  const value = valueAt(payload, issue.path)
  if (lastKey(issue.path) === 'schemaVersion') {
    return {
      code: 'SCHEMA_VERSION',
      path: 'schemaVersion',
      message:
        value === undefined
          ? 'The package has no schemaVersion.'
          : `schemaVersion ${quote(value)} is not supported.`,
      fix: 'Use schemaVersion 3 for new work: it carries provenance for every record and can update or remove existing records by id. Versions 1 and 2 still import but have no provenance.',
      example:
        '{ "schemaVersion": 3, "places": { "create": [] }, "knowledgeEntries": { "create": [] } }',
    }
  }
  if (lastKey(issue.path) === 'itemType') {
    return {
      code: 'NOT_ALLOWED_VALUE',
      path,
      message: `itemType ${quote(value)} is not one of the broad item types.`,
      fix: `Use one of: ${ITEM_TYPES}; or omit itemType. Put the specific kind ("roller coaster", "cafe") in type.`,
      example: '"type": "roller coaster", "itemType": "activity"',
    }
  }
  return {
    code: 'INVALID_VALUE',
    path,
    message: `${quote(value)} does not match any accepted form.`,
    fix: 'Compare this field with the schema from operator.get_manual (section "venue-authoring").',
  }
}

function invalidType(
  issue: Extract<Issue, { code: 'invalid_type' }>,
  payload: unknown,
): PackageIssue {
  const path = pathText(issue.path)
  const value = valueAt(payload, issue.path)
  const key = lastKey(issue.path)
  if (value === undefined) {
    return {
      code: 'MISSING_FIELD',
      path,
      message: `Required field "${key}" is missing.`,
      fix:
        key === 'places' || key === 'knowledgeEntries'
          ? `schemaVersion 3 needs ${key} as an object of operation lists, even when empty.`
          : key === 'provenance'
            ? 'Every schemaVersion 3 operation needs provenance: sourceType and contentOrigin are required.'
            : `Add "${key}" with a ${issue.expected} value. Never invent a fact to fill it: if the fact is unknown, leave the record out.`,
      ...(key === 'places' || key === 'knowledgeEntries'
        ? { example: `"${key}": { "create": [] }` }
        : key === 'provenance'
          ? {
              example:
                '"provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" }',
            }
          : {}),
    }
  }
  if ((key === 'places' || key === 'knowledgeEntries') && Array.isArray(value)) {
    return {
      code: 'WRONG_SHAPE',
      path,
      message: `In schemaVersion 3, ${key} is an object of operation lists, not an array.`,
      fix: 'Wrap each record as an operation with a new UUID itemKey, provenance and value.',
      example:
        key === 'places'
          ? '"places": { "create": [ { "itemKey": "<new uuid>", "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" }, "value": { "name": "Cinderswing", "type": "pendulum ride" } } ] }'
          : '"knowledgeEntries": { "create": [ { "itemKey": "<new uuid>", "provenance": { "sourceType": "official_website", "contentOrigin": "AI_GENERATED" }, "value": { "title": "Parking", "category": "Visiting", "content": "Parking is free." } } ] }',
    }
  }
  const numeric = issue.expected === 'number' && typeof value === 'string'
  return {
    code: 'WRONG_TYPE',
    path,
    message: `Expected ${issue.expected}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}.`,
    fix: numeric ? 'Write the number without quotes.' : `Give "${key}" a ${issue.expected} value.`,
    ...(numeric && /^-?\d+(?:\.\d+)?$/u.test(String(value))
      ? { example: `"${key}": ${String(value)}` }
      : {}),
  }
}

function format(issue: Extract<Issue, { code: 'invalid_format' }>, payload: unknown): PackageIssue {
  const path = pathText(issue.path)
  const key = lastKey(issue.path)
  if (issue.format === 'uuid') {
    return {
      code: 'INVALID_ITEM_KEY',
      path,
      message: `${quote(valueAt(payload, issue.path))} is not a UUID.`,
      fix: 'Give every operation a newly generated UUID (crypto.randomUUID()). Keep the same itemKey when you re-check the same package; never reuse one for a different record.',
      example: '"itemKey": "3f1c2b9e-7a4d-4e1b-9c2a-5d6e7f8a9b0c"',
    }
  }
  if (issue.format === 'cuid') {
    return {
      code: 'INVALID_RECORD_ID',
      path,
      message: `${quote(valueAt(payload, issue.path))} is not an existing record id.`,
      fix: 'Update and delete operations need the id of the existing record, from venues.list_content (representation LEGACY_PLACE or LEGACY_KNOWLEDGE). To add a new record, use create instead.',
    }
  }
  return {
    code: 'INVALID_FORMAT',
    path,
    message: `"${key}" is not a valid ${issue.format}.`,
    fix:
      issue.format === 'url'
        ? 'Use a full public https:// link with no credentials, or leave the field out.'
        : `Use a valid ${issue.format}.`,
  }
}

function size(
  issue: Extract<Issue, { code: 'too_big' | 'too_small' }>,
  payload: unknown,
): PackageIssue {
  const path = pathText(issue.path)
  const key = lastKey(issue.path)
  const big = issue.code === 'too_big'
  const limit = big
    ? (issue as Extract<Issue, { code: 'too_big' }>).maximum
    : (issue as Extract<Issue, { code: 'too_small' }>).minimum
  const value = valueAt(payload, issue.path)
  const length = typeof value === 'string' ? ` (${value.length} characters)` : ''
  if (issue.origin === 'string') {
    return {
      code: big ? 'TOO_LONG' : 'EMPTY_FIELD',
      path,
      message: big
        ? `"${key}" is longer than ${String(limit)} characters${length}.`
        : `"${key}" is empty.`,
      fix: big
        ? key === 'shortDescription'
          ? 'Keep the first sentence here and move the rest to longDescription (up to 2,000).'
          : key === 'longDescription' || key === 'content'
            ? 'Split it into separate records, one subject each (for example one topic per policy or per category list).'
            : `Shorten it to ${String(limit)} characters.`
        : 'Give it real text, or leave the record out. Never fill it with a placeholder.',
    }
  }
  if (issue.origin === 'number') {
    return {
      code: 'OUT_OF_RANGE',
      path,
      message: `${quote(value)} is ${big ? 'above' : 'below'} the ${big ? 'maximum' : 'minimum'} ${String(limit)}.`,
      fix:
        key === 'lat' || key === 'lng'
          ? 'lat is -90..90 and lng is -180..180 decimal degrees; check they are not swapped.'
          : `Use a value ${big ? 'at most' : 'at least'} ${String(limit)}.`,
    }
  }
  return {
    code: big ? 'TOO_MANY' : 'TOO_FEW',
    path: path || '(package)',
    message: issue.message,
    fix: big
      ? 'Split the work into several packages, each checked and imported on its own.'
      : 'Add the missing items.',
  }
}

function custom(issue: Issue): PackageIssue {
  const path = pathText(issue.path)
  const message = issue.message
  if (/Latitude and longitude/iu.test(message)) {
    return {
      code: 'COORDINATE_PAIR',
      path,
      message,
      fix: 'Give lat and lng together, or neither (and use guideMode non_location for a guide without mapped places).',
      example: '"lat": 42.4651, "lng": -92.342',
    }
  }
  if (/item keys must be unique/iu.test(message)) {
    return {
      code: 'DUPLICATE_ITEM_KEY',
      path,
      message,
      fix: 'Generate a separate UUID for every operation.',
    }
  }
  if (/targeted only once/iu.test(message)) {
    return {
      code: 'DUPLICATE_TARGET',
      path,
      message,
      fix: 'Merge the two operations on this record into one update that carries its full desired state.',
    }
  }
  if (/Source URLs/iu.test(message)) {
    return {
      code: 'UNSAFE_SOURCE_URL',
      path,
      message,
      fix: 'Use the public http(s) page address with no tokens, keys, signatures or credentials, or omit sourceUrl and keep sourceName.',
    }
  }
  if (/at least one/iu.test(message)) {
    return {
      code: 'EMPTY_PACKAGE',
      path: path || '(package)',
      message,
      fix: 'Add at least one create, update or delete operation (or venue patch).',
    }
  }
  return { code: 'INVALID_PACKAGE', path: path || '(package)', message, fix: 'See the message.' }
}

/** Fixes for the server preview's own error codes (stage two, after the shape is valid). */
const PREVIEW_FIXES: Readonly<Record<string, string>> = {
  LOCATION_REQUIRED:
    'This venue is location-aware, so every active place needs lat and lng. Add the verified pin, or set guideMode non_location with venues.propose_update if the guide has no map. Never guess coordinates.',
  DUPLICATE_IN_PACKAGE:
    'Two records in this package have the same name or title. Merge them into one record, or give each a title that says what it covers.',
  DUPLICATE_EXISTING_CONTENT:
    'The venue already has a record with this name or title. Change that record with a schemaVersion 3 update by id (venues.list_content, representation LEGACY_PLACE or LEGACY_KNOWLEDGE) instead of creating a second one.',
  TARGET_NOT_FOUND:
    'No record with this id exists in this venue. Read current ids with venues.list_content (representation LEGACY_PLACE or LEGACY_KNOWLEDGE), or use create for a new record.',
  NO_CHANGES:
    'The record already has exactly this state. Remove the operation; nothing needs to change.',
  DELETE_BLOCKED:
    'Other data still refers to this place. Send an update with isActive false instead of deleting it.',
  HISTORY_MISSING:
    'The record has no version history, so it cannot be changed by a package. Report this record id; do not retry.',
}

/** Adds a fix to a server preview error or warning, when there is a known one. */
export function withPreviewFix<T extends { code: string }>(issue: T): T & { fix?: string } {
  const fix = PREVIEW_FIXES[issue.code]
  return fix ? { ...issue, fix } : issue
}

export function explainVenuePackageIssues(
  issues: readonly Issue[],
  payload: unknown,
): PackageIssue[] {
  return issues.flatMap((issue): PackageIssue[] => {
    switch (issue.code) {
      case 'unrecognized_keys':
        return unrecognized(issue)
      case 'invalid_value':
        return [invalidValue(issue, payload)]
      case 'invalid_union':
        return [union(issue, payload)]
      case 'invalid_type':
        return [invalidType(issue, payload)]
      case 'invalid_format':
        return [format(issue, payload)]
      case 'too_big':
      case 'too_small':
        return [size(issue, payload)]
      default:
        return [custom(issue)]
    }
  })
}
