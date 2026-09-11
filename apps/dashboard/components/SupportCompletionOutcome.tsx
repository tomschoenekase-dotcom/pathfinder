export type SupportCompletionOutcomeValue = 'UPDATED' | 'NO_CHANGE' | 'MIXED' | 'RESOLVED'

const labels: Record<SupportCompletionOutcomeValue, string> = {
  UPDATED: 'Updates applied',
  NO_CHANGE: 'No change needed',
  MIXED: 'Updates and reviewed items',
  RESOLVED: 'Request resolved',
}

export function SupportCompletionOutcome({
  outcome,
  className = '',
}: {
  outcome: SupportCompletionOutcomeValue
  className?: string
}) {
  return (
    <p className={`text-xs font-bold uppercase tracking-[0.12em] ${className}`}>
      {labels[outcome]}
    </p>
  )
}
