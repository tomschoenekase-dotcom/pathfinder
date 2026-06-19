// Tailwind classes for a tenant status pill (light theme, matches the dashboard).
export function getStatusClasses(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'TRIAL':
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case 'SUSPENDED':
      return 'border-rose-200 bg-rose-50 text-rose-700'
    default:
      return 'border-pf-light bg-pf-surface text-pf-deep/60'
  }
}

// Tailwind classes for a job status pill.
export function getJobStatusClasses(status: string): string {
  switch (status) {
    case 'COMPLETE':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'RUNNING':
      return 'border-sky-200 bg-sky-50 text-sky-700'
    case 'FAILED':
      return 'border-rose-200 bg-rose-50 text-rose-700'
    default:
      return 'border-pf-light bg-pf-surface text-pf-deep/60'
  }
}
