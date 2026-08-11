export function mergeClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2'

export const disabledControl =
  'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50'

export const restrainedMotion = 'transition-colors motion-reduce:transition-none'
