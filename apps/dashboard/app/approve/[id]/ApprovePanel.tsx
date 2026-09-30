'use client'

import { DecisionButtons } from '../../../components/operator/DecisionButtons'

/** Big Approve and Reject buttons pinned to the bottom of the phone screen. */
export function ApprovePanel({
  id,
  argsHash,
  label,
}: {
  id: string
  argsHash: string
  label: string
}) {
  return (
    <div className="sticky bottom-0 border-t border-tk-rule bg-tk-paper px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
      <DecisionButtons id={id} argsHash={argsHash} size="large" label={label} />
    </div>
  )
}
