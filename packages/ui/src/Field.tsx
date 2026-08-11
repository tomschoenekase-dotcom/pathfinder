import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

import { disabledControl, focusRing, mergeClasses, restrainedMotion } from './styles'

const controlClasses = mergeClasses(
  'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 shadow-sm',
  'placeholder:text-slate-400 hover:border-slate-400',
  'aria-[invalid=true]:border-red-600 aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-red-600',
  focusRing,
  disabledControl,
  restrainedMotion,
)

export type InputProps = InputHTMLAttributes<HTMLInputElement>

export function Input({ className, ...props }: InputProps) {
  return <input className={mergeClasses(controlClasses, className)} {...props} />
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea className={mergeClasses(controlClasses, 'min-h-24 resize-y', className)} {...props} />
  )
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>

export function Select({ className, ...props }: SelectProps) {
  return <select className={mergeClasses(controlClasses, className)} {...props} />
}

export type FieldProps = {
  children: ReactElement
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: ReactNode
  optional?: boolean
  className?: string
}

export function Field({
  children,
  className,
  error,
  hint,
  htmlFor,
  label,
  optional = false,
}: FieldProps) {
  const generatedId = useId()
  const validChild = isValidElement<Record<string, unknown>>(children) ? children : null
  const childId = typeof validChild?.props.id === 'string' ? validChild.props.id : undefined
  const controlId = htmlFor ?? childId ?? generatedId
  const descriptionId = `${controlId}-description`
  const control = validChild
    ? cloneElement(validChild, {
        id: controlId,
        'aria-describedby':
          error || hint
            ? [validChild.props['aria-describedby'], descriptionId].filter(Boolean).join(' ')
            : validChild.props['aria-describedby'],
        'aria-invalid': error ? true : validChild.props['aria-invalid'],
      })
    : children

  return (
    <div className={mergeClasses('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-sm font-medium text-slate-900" htmlFor={controlId}>
          {label}
        </label>
        {optional ? <span className="text-xs text-slate-500">Optional</span> : null}
      </div>
      {control}
      {error ? (
        <p id={descriptionId} role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={descriptionId} className="text-sm text-slate-600">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
