/** A narrow, conservative check for posted hours before today's opening time. */

type HoursTopic = { title: string; content: string }
type ActiveUpdate = { title?: string | null; body?: string | null }

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
const DAY_LIST =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s*(?:,|and|&|[-–]|to|through)\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))*$/iu

function minutesOf(clock: string): number | null {
  const normalized = clock.trim().toLowerCase()
  if (normalized === 'noon') return 12 * 60
  if (normalized === 'midnight') return 0
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(normalized)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (hour < 1 || hour > 12 || minute > 59) return null
  return (hour % 12) * 60 + (match[3] === 'pm' ? 12 * 60 : 0) + minute
}

function venueLocalDayAndMinute(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  )
  return { weekday: parts.weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

/**
 * Returns a cue only when a published hours line unambiguously proves that today's regular
 * opening time is still in the future. It never asserts that a place is open; special closures,
 * early openings and free-form schedules need the ordinary guide answer path.
 */
export function guestBeforeOpeningCue(params: {
  question: string
  now: Date
  timeZone: string | undefined
  knowledge: ReadonlyArray<HoursTopic>
  activeUpdates?: ReadonlyArray<ActiveUpdate>
}): string | null {
  if (!params.timeZone || !/\b(?:open|closed)\b/iu.test(params.question)) return null
  if (!/\b(?:now|currently|yet|today|at the moment)\b/iu.test(params.question)) return null
  // Any live operational notice may alter normal entry, even without using the word "hours".
  if (params.activeUpdates?.length) return null

  let local: ReturnType<typeof venueLocalDayAndMinute>
  try {
    local = venueLocalDayAndMinute(params.now, params.timeZone)
  } catch {
    return null
  }
  if (!DAYS.some((day) => day === local.weekday)) return null

  const hoursTopics = params.knowledge.filter(
    (entry) => /\bhours?\b/iu.test(entry.title) && /^Hours:/imu.test(entry.content),
  )
  if (hoursTopics.length !== 1) return null
  const hoursTopic = hoursTopics[0]
  if (!hoursTopic) return null
  const posted = hoursTopic.content.split(/\r?\n/u).find((line) => /^Hours:\s*[^,]+,/iu.test(line))
  if (!posted) return null
  const prefix = /^Hours:\s*([^,]+),\s*(.+)$/iu.exec(posted)
  if (!prefix) return null
  const subject = prefix[1]?.trim()
  const schedule = prefix[2]
  if (!subject || !schedule || !/^[\p{L}\p{N}][\p{L}\p{N} &'().-]{0,79}$/u.test(subject))
    return null

  const subjectSchedules = hoursTopic.content
    .split(/\r?\n/u)
    .filter((line) => /^Hours:\s*[^,]+,/iu.test(line))
    .filter((line) => /^Hours:\s*([^,]+),/iu.exec(line)?.[1]?.trim() === subject)
  if (subjectSchedules.length !== 1) return null

  const namedSubjects = hoursTopic.content.split(/\r?\n/u).flatMap((line) => {
    const match = /^Hours:\s*([^,]+),/iu.exec(line)
    return match?.[1] ? [match[1].trim()] : []
  })
  const mentionedSubjects = namedSubjects.filter((name) =>
    params.question.toLowerCase().includes(name.toLowerCase()),
  )
  if (new Set(namedSubjects).size > 1 && new Set(mentionedSubjects).size !== 1) return null
  if (mentionedSubjects.length && !mentionedSubjects.includes(subject)) return null

  const todaySegments = schedule
    .split(';')
    .filter((part) => new RegExp(`\\b${local.weekday}\\b`, 'iu').test(part))
  if (todaySegments.length !== 1) return null
  for (const part of todaySegments) {
    const match =
      /^\s*((?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight))\s*[-–]\s*((?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight))\s+(.+?)\s*$/iu.exec(
        part,
      )
    if (!match) continue
    const dayList = match[3]
    if (!dayList || !new RegExp(`\\b${local.weekday}\\b`, 'iu').test(dayList)) continue
    // A date or season qualifier requires its own calendar calculation.
    if (!DAY_LIST.test(dayList.trim())) return null
    const openingMinute = minutesOf(match[1] ?? '')
    const closingMinute = minutesOf(match[2] ?? '')
    if (
      openingMinute === null ||
      closingMinute === null ||
      openingMinute >= closingMinute ||
      local.minute >= openingMinute
    )
      return null
    const opening = match[1]?.trim()
    return `CURRENT POSTED HOURS CHECK: It is ${local.weekday} before ${subject}'s regular ${opening} opening time, so ${subject} is closed now according to its posted hours. Do not say it is open now. Do not infer whether a holiday or special event changes its next opening time.`
  }
  return null
}
