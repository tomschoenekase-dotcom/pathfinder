import type { ReactNode } from 'react'

/**
 * The client portal's small shared vocabulary: warm paper, deep ink, restrained rules and
 * content-sized sections. Ember is reserved for something the venue genuinely needs to do.
 */

export const portalFocus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2 focus-visible:ring-offset-tk-paper'

const buttonBase = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-55 ${portalFocus}`

/** Routine primary action: navy. */
export const portalButtonPrimary = `${buttonBase} bg-tk-ink text-white hover:bg-tk-focus`
/** Routine secondary action: outlined. */
export const portalButtonSecondary = `${buttonBase} border border-tk-rule-strong bg-tk-card text-tk-ink hover:border-tk-ink hover:bg-white`
/** Reserved for an action the venue genuinely owes (payment due, answering Torchiko). */
export const portalButtonAttention = `${buttonBase} bg-tk-ember-text text-white hover:bg-[#8E3421]`
export const portalTextLink = `rounded-sm font-semibold text-tk-focus underline decoration-tk-focus/40 underline-offset-4 hover:decoration-tk-focus ${portalFocus}`

export const portalInput = `block min-h-11 w-full rounded-lg border border-tk-rule-strong bg-white px-3 text-sm text-tk-ink placeholder:text-tk-soft focus-visible:border-tk-focus ${portalFocus}`

export function PortalPage({
  title,
  description,
  aside,
  children,
  width = 'standard',
}: {
  title: ReactNode
  description?: ReactNode
  aside?: ReactNode
  children: ReactNode
  width?: 'standard' | 'wide' | 'narrow'
}) {
  const maxWidth =
    width === 'wide' ? 'max-w-[76rem]' : width === 'narrow' ? 'max-w-3xl' : 'max-w-[64rem]'
  return (
    <div className="min-h-screen bg-tk-paper text-tk-ink">
      <div className={`mx-auto ${maxWidth} px-4 pb-16 pt-6 sm:px-8 sm:pt-10 lg:px-10 lg:pt-12`}>
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words font-portal text-[2rem] leading-[1.1] tracking-[-0.01em] text-tk-ink sm:text-[2.6rem]">
              {title}
            </h1>
            {description ? (
              <p className="mt-2 max-w-2xl text-[0.95rem] leading-6 text-tk-soft">{description}</p>
            ) : null}
          </div>
          {aside ? <div className="shrink-0">{aside}</div> : null}
        </header>
        <div className="mt-6 sm:mt-8">{children}</div>
      </div>
    </div>
  )
}

export function PortalSection({
  id,
  title,
  description,
  titleAside,
  children,
  className = '',
  as: Heading = 'h2',
}: {
  id: string
  title: ReactNode
  description?: ReactNode
  titleAside?: ReactNode
  children?: ReactNode
  className?: string
  as?: 'h2' | 'h3'
}) {
  return (
    <section
      aria-labelledby={id}
      className={`min-w-0 rounded-xl border border-tk-rule bg-tk-card p-5 sm:p-6 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Heading id={id} className="font-portal text-[1.45rem] leading-tight text-tk-ink">
          {title}
        </Heading>
        {titleAside}
      </div>
      {description ? (
        <p className="mt-1.5 max-w-prose text-sm leading-6 text-tk-soft">{description}</p>
      ) : null}
      {children}
    </section>
  )
}

/** A quiet, non-blocking inline status line. */
export function PortalNotice({
  tone = 'neutral',
  children,
  role = 'status',
}: {
  tone?: 'neutral' | 'success' | 'attention' | 'error'
  children: ReactNode
  role?: 'status' | 'alert'
}) {
  const toneClass =
    tone === 'error'
      ? 'border-tk-danger/40 bg-[#FBEFEF] text-tk-danger'
      : tone === 'attention'
        ? 'border-tk-ember/40 bg-tk-ember-wash text-tk-ember-text'
        : tone === 'success'
          ? 'border-tk-moss/35 bg-[#EEF5F1] text-tk-moss'
          : 'border-tk-rule bg-tk-paper text-tk-ink'
  return (
    <p role={role} className={`rounded-lg border px-3 py-2.5 text-sm leading-6 ${toneClass}`}>
      {children}
    </p>
  )
}
