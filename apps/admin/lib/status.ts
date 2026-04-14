export function getStatusClasses(status: string) {
  if (status === 'ACTIVE') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  }

  if (status === 'SUSPENDED') {
    return 'border-rose-200 bg-rose-50 text-rose-700'
  }

  return 'border-amber-200 bg-amber-50 text-amber-700'
}
