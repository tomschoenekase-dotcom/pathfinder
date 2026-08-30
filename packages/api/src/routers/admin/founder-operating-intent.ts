export type FounderOperatingIntent =
  | 'TOP_PRIORITY'
  | 'DECISIONS'
  | 'INCIDENTS'
  | 'AGENT_ACTIVITY'
  | 'CUSTOMER_ISSUES'
  | 'CHANGES'
  | 'COSTS'
  | 'DIRECTIVE'

function normalized(prompt: string) {
  return ` ${prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()} `
}

function includesAny(value: string, phrases: string[]) {
  return phrases.some((phrase) => value.includes(` ${phrase} `))
}

export function classifyFounderOperatingIntent(prompt: string): FounderOperatingIntent {
  const value = normalized(prompt)
  if (
    includesAny(value, [
      'highest value',
      'next five minutes',
      'top priority',
      'what should i do',
      'where should i focus',
    ])
  )
    return 'TOP_PRIORITY'
  if (
    includesAny(value, [
      'agents waiting',
      'agent waiting',
      'workers waiting',
      'worker waiting',
      'agents doing',
      'agent doing',
      'workers doing',
      'worker doing',
      'agent status',
      'worker status',
      'ai workforce',
    ])
  )
    return 'AGENT_ACTIVITY'
  if (
    includesAny(value, [
      'needs my decision',
      'need my decision',
      'needs me',
      'need me',
      'approval',
      'approvals',
      'decision',
      'decisions',
    ])
  )
    return 'DECISIONS'
  if (includesAny(value, ['broken', 'incident', 'incidents', 'outage', 'risk', 'risks']))
    return 'INCIDENTS'
  if (
    includesAny(value, [
      'customer issue',
      'customer issues',
      'support issue',
      'support issues',
      'customer attention',
      'venue issue',
      'venue issues',
    ])
  )
    return 'CUSTOMER_ISSUES'
  if (includesAny(value, ['what changed', 'changes', 'what is new', 'what have you learned']))
    return 'CHANGES'
  if (includesAny(value, ['cost', 'costs', 'costing', 'spend', 'spending', 'expensive', 'expense']))
    return 'COSTS'
  if (includesAny(value, ['agent', 'agents', 'worker', 'workers'])) return 'AGENT_ACTIVITY'
  return 'DIRECTIVE'
}
