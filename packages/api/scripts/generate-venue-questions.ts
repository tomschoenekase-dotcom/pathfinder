/** Local, deterministic lab cases. Usage: tsx scripts/generate-venue-questions.ts --input venue.json --out output-dir
 * Input: { slug, at?, knowledge: [{title, category, content}], places?: [...] }.
 * Writes cases.json (lab Case[]) and truth.json (case ID -> expected facts); never calls a model.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const recordSchema = z.object({
  title: z.string().min(1),
  category: z.string(),
  content: z.string(),
  isEnabled: z.boolean().optional(),
  visibility: z.string().optional(),
})
const inputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
  at: z.string().datetime({ offset: true }).optional(),
  knowledge: z.array(recordSchema),
  places: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        shortDescription: z.string().nullable().optional(),
        longDescription: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
        visibility: z.string().optional(),
      }),
    )
    .optional(),
})
type RecordInput = z.infer<typeof recordSchema>
export type VenueQuestionInput = z.infer<typeof inputSchema>
export type VenueQuestionCase = {
  id: string
  venue: string
  at: string
  tags: string[]
  turns: string[]
}

function labeled(record: RecordInput, label: string): string | undefined {
  return record.content
    .split(/\r?\n/)
    .find((line) => new RegExp(`^${label}\\s*:`, 'i').test(line.trim()))
    ?.trim()
}
function value(line: string): string {
  return line.slice(line.indexOf(':') + 1).trim()
}
function isCoaster(record: RecordInput): boolean {
  const lead = record.content.split(/\r?\n/)[0] ?? ''
  return (
    /\bis an? [^.]*\bcoaster\b/i.test(lead) &&
    !/not (?:a |an )?(?:roller )?coaster|future|planned|coming|former (?:\w+ )*(?:coaster|ride)|retired|not (?:yet )?open|has not opened|will open|scheduled to open|permanently closed/i.test(
      record.content
        .split(/\r?\n/)
        .filter((line) => !/^\s*[\w ]+:/.test(line) || /^\s*status:/i.test(line))
        .join(' '),
    )
  )
}

export function generateVenueQuestions(raw: VenueQuestionInput): {
  cases: VenueQuestionCase[]
  truth: Record<string, string>
  groupedRideQuestions: number
} {
  const input = inputSchema.parse(raw)
  const recordsByTitle = new Map<string, RecordInput>()
  for (const place of input.places ?? []) {
    if (place.isActive === false || (place.visibility ?? 'PUBLIC') !== 'PUBLIC') continue
    recordsByTitle.set(place.name.trim().toLowerCase(), {
      title: place.name,
      category: place.type,
      content: [place.shortDescription, place.longDescription].filter(Boolean).join('\n'),
    })
  }
  for (const record of input.knowledge) {
    if (record.isEnabled === false || (record.visibility ?? 'PUBLIC') !== 'PUBLIC') continue
    const key = record.title.trim().toLowerCase()
    const place = recordsByTitle.get(key)
    recordsByTitle.set(
      key,
      place ? { ...record, content: `${record.content}\n${place.content}` } : record,
    )
  }
  const records = [...recordsByTitle.values()]
    .filter((record) => record.isEnabled !== false && (record.visibility ?? 'PUBLIC') === 'PUBLIC')
    .sort((a, b) => a.title.localeCompare(b.title) || a.content.localeCompare(b.content))
  const rides = records
    .filter(isCoaster)
    .filter(
      (record, index, all) => all.findIndex((other) => other.title === record.title) === index,
    )
  const makers = rides.map((ride) => {
    const line = labeled(
      ride,
      '(?:made by|built by|designed by|manufacturer|maker|designed and built by)',
    )
    return {
      ride,
      line:
        line &&
        !/^(?:unknown|not (?:known|documented|published|available)|unconfirmed|tbd|n\/?a)\.?$/i.test(
          value(line),
        )
          ? line
          : undefined,
    }
  })
  const makerNames = makers.flatMap(({ line }) => (line ? [value(line)] : []))
  let absent = ['Intamin', 'Vekoma', 'Mack', 'Gerstlauer', 'Zierer', 'Maurer', 'Zamperla'].find(
    (name) => !records.some((record) => record.content.toLowerCase().includes(name.toLowerCase())),
  )
  for (let suffix = 1; absent === undefined; suffix++) {
    const candidate = `Absent Maker ${suffix}`
    if (!records.some((record) => record.content.toLowerCase().includes(candidate.toLowerCase())))
      absent = candidate
  }
  const unknownMaker = makers.filter(({ line }) => !line).map(({ ride }) => ride.title)
  const food = records.filter(
    (record) => /dining|food|restaurant|cafe/i.test(record.category) || !!labeled(record, 'Menu'),
  )
  const foodPlaces = (input.places ?? []).filter(
    (place) =>
      place.isActive !== false &&
      (place.visibility ?? 'PUBLIC') === 'PUBLIC' &&
      /dining|food|restaurant|cafe/i.test(place.type),
  )
  const foodFact =
    [
      ...food.map(
        (record) =>
          `${record.title}: ${labeled(record, 'Menu') ?? record.content.split(/\r?\n/)[0]}`,
      ),
      ...foodPlaces.map(
        (place) =>
          `${place.name}: ${place.shortDescription ?? place.longDescription ?? place.type}`,
      ),
    ].join('; ') || 'No food location is documented; do not invent one.'
  const alcoholFact =
    records
      .flatMap((record) => {
        const line = labeled(record, 'Alcohol')
        return line ? [`${record.title}: ${line}`] : []
      })
      .join('; ') || 'Alcohol availability is not documented; do not assume beer is sold.'
  const sizes = rides.map((ride) => ({ ride, line: labeled(ride, 'Size and speed') }))
  const speeds = sizes.flatMap(({ ride, line }) => {
    const speed = line?.match(/(\d+(?:\.\d+)?)\s*mph\b/i)
    return speed ? [{ title: ride.title, speed: Number(speed[1]), line: line! }] : []
  })
  const maximum = Math.max(...speeds.map((ride) => ride.speed))
  const fastest = speeds.length
    ? `${speeds
        .filter((ride) => ride.speed === maximum)
        .map((ride) => `${ride.title}: ${ride.line}`)
        .join(
          '; ',
        )}. Fastest among rides with documented mph; ${rides.length - speeds.length} coaster speed(s) missing.`
    : 'No coaster speed is documented; do not guess a fastest coaster.'
  const attendance = records.flatMap((record) =>
    record.content
      .split(/\r?\n/)
      .filter((line) =>
        /attendance|annual (?:visitors|guests)|visitors (?:per|a) year/i.test(line),
      ),
  )
  const attendanceFact = attendance.length
    ? attendance.join('; ')
    : 'Attendance is not published in these records. Do not give a number or estimate.'
  const rows: { question: string; expected: string; tag: string }[] = []
  const add = (question: string, expected: string, tag: string) =>
    rows.push({ question, expected, tag })
  add(
    `Any ${absent} rides here?`,
    unknownMaker.length
      ? `No record names ${absent}; maker unknown for ${unknownMaker.join(', ')}. Do not conclude none.`
      : `No record names ${absent}; all ${rides.length} documented current coasters have another maker. Do not invent a ride.`,
    'maker-absence',
  )
  if (makerNames.length)
    add(
      `Any ${makerNames[0]} rides here?`,
      makers
        .filter(({ line }) => line && value(line) === makerNames[0])
        .map(({ ride, line }) => `${ride.title}: ${line}`)
        .join('; '),
      'maker-presence',
    )
  add(
    'How many coasters are here?',
    `${rides.length} documented current coasters: ${rides.map((ride) => ride.title).join(', ') || 'none'}. Exclude future rides and non-coasters.`,
    'coaster-count',
  )
  add('What is the fastest coaster?', fastest, 'fastest')
  add('Where can I get food?', foodFact, 'food')
  add('Can I get a beer?', alcoholFact, 'alcohol')
  add('How many people come here a year?', attendanceFact, 'attendance')
  const casual = [
    ['fuck I need a drink', alcoholFact],
    ["I'm starving, where should I go?", foodFact],
    [
      'Hey, what coasters have you got?',
      `${rides.map((ride) => ride.title).join(', ') || 'No documented current coasters'}.`,
    ],
    ['Whoa, which coaster is the fastest?', fastest],
    ['Can I grab a beer with lunch?', `${foodFact} ${alcoholFact}`],
  ]
  for (const [question, expected] of casual) add(question!, expected!, 'casual')
  const overflow: { question: string; expected: string }[] = []
  for (const { ride, line } of makers) {
    if (rows.length < 40)
      add(
        `Who made ${ride.title}?`,
        line ?? `The maker of ${ride.title} is not documented; do not guess.`,
        'ride-maker',
      )
    else
      overflow.push({
        question: `Who made ${ride.title}?`,
        expected: line ?? `The maker of ${ride.title} is not documented; do not guess.`,
      })
    const size = labeled(ride, 'Size and speed')
    // Height means the ride structure, never a rider Height line or a degree/drop measurement.
    if (
      size &&
      /\d+(?:\.\d+)?[\s-]*(?:ft|feet|foot)[\s-]*(?:tall|high)|(?:height|tall|high)\s*(?:of |is |: )?\d+(?:\.\d+)?[\s-]*(?:ft|feet|foot)/i.test(
        size,
      ) &&
      /\d+(?:\.\d+)?\s*mph\b/i.test(size)
    ) {
      if (rows.length < 40) add(`How tall and fast is ${ride.title}?`, size, 'ride-size')
      else overflow.push({ question: `How tall and fast is ${ride.title}?`, expected: size })
    }
  }
  const extras = [
    ['Where can we eat lunch?', foodFact],
    ['Do you sell wine?', alcoholFact],
    [
      'What are my coaster options?',
      rides.map((ride) => ride.title).join(', ') || 'No documented current coasters.',
    ],
    ['Is there a place to grab a snack?', foodFact],
    ['Where should I go for dinner?', foodFact],
    ['Is alcohol available here?', alcoholFact],
    ['Do you publish annual attendance?', attendanceFact],
    ['Which coaster has the highest recorded speed?', fastest],
    ['What food is available?', foodFact],
  ]
  for (const [question, expected] of extras)
    if (rows.length < 20) add(question!, expected!, 'general')
  const cases = rows.map((row, index) => ({
    id: `${input.slug}-${String(index + 1).padStart(2, '0')}`,
    venue: input.slug,
    at: input.at ?? '2026-10-13T12:00:00-05:00',
    tags: [row.tag],
    turns: [row.question],
  }))
  const truth = Object.fromEntries(cases.map((entry, index) => [entry.id, rows[index]!.expected]))
  const rideCases = cases.filter((entry) =>
    entry.tags.some((tag) => tag === 'ride-maker' || tag === 'ride-size'),
  )
  for (const [index, row] of overflow.entries()) {
    const entry = rideCases[index % rideCases.length]!
    if (entry.turns.length === 1) truth[entry.id] = `Turn 1: ${truth[entry.id]}`
    entry.turns.push(row.question)
    truth[entry.id] += `\nTurn ${entry.turns.length}: ${row.expected}`
  }
  return { cases, truth, groupedRideQuestions: overflow.length }
}

export function runVenueQuestionCli(args: string[]): void {
  const argument = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const inputPath = argument('--input')
  const outputPath = argument('--out')
  if (!inputPath || !outputPath)
    throw new Error('Usage: generate-venue-questions.ts --input venue.json --out output-dir')
  const generated = generateVenueQuestions(
    JSON.parse(readFileSync(resolve(inputPath), 'utf8')) as VenueQuestionInput,
  )
  mkdirSync(resolve(outputPath), { recursive: true })
  writeFileSync(resolve(outputPath, 'cases.json'), `${JSON.stringify(generated.cases, null, 2)}\n`)
  writeFileSync(resolve(outputPath, 'truth.json'), `${JSON.stringify(generated.truth, null, 2)}\n`)
  if (generated.groupedRideQuestions)
    process.stderr.write(
      `40-case limit: ${generated.groupedRideQuestions} additional ride questions grouped into multi-turn cases; truth includes expected facts for each turn.\n`,
    )
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runVenueQuestionCli(process.argv.slice(2))
