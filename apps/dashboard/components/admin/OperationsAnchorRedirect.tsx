'use client'

import { useEffect } from 'react'

// Existing deep links predate the System tabs. Keep them pointed at the
// actual working section when a caller omits the tab query parameter.
const WORK_ANCHORS = new Set([
  'founder-now',
  'founder-briefing-heading',
  'cost-coverage',
  'cost-coverage-heading',
  'agent-trust-evidence-heading',
  'ai-workforce',
  'alerts',
  'customer-alerts',
  'platform-operational-events-heading',
  'operational-events-heading',
  'needs-you-heading',
  'agent-work-heading',
  'outcomes-heading',
  'job-attention-heading',
  'evaluation-attention-heading',
  'approval-attention-heading',
  'support-attention-heading',
])

export function OperationsAnchorRedirect() {
  useEffect(() => {
    const target = workAnchorTarget(window.location.hash)
    if (target) window.location.replace(target)
  }, [])
  return null
}

export function workAnchorTarget(hash: string) {
  const anchor = hash.startsWith('#') ? hash.slice(1) : hash
  return WORK_ANCHORS.has(anchor) ? `/admin/operations?view=work#${anchor}` : null
}
