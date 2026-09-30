'use client'

/** Browser half of Packet 14's webpack-only Clerk replacement. */
import {
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

type BrowserIdentity = {
  userId: string
  orgId: string | null
  selector: 'admin' | 'owner-a' | 'owner-b'
  platformAdmin: boolean
}

function useFixtureIdentity(): BrowserIdentity | null {
  const [identity, setIdentity] = useState<BrowserIdentity | null>(null)
  useEffect(() => {
    let active = true
    fetch('/api/local-auth-state', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: unknown) => {
        if (active) {
          setIdentity(
            value && typeof value === 'object' && 'selector' in value
              ? (value as BrowserIdentity)
              : null,
          )
        }
      })
      .catch(() => {
        if (active) setIdentity(null)
      })
    return () => {
      active = false
    }
  }, [])
  return identity
}

export function ClerkProvider({ children }: { children: ReactNode }) {
  return children
}

export function SignIn() {
  return createElement(
    'form',
    { method: 'post', action: '/sign-in' },
    createElement('h1', null, 'Local fixture sign in'),
    createElement(
      'label',
      null,
      'Identity',
      createElement(
        'select',
        { name: 'identity', required: true },
        createElement('option', { value: 'admin' }, 'Platform admin'),
        createElement('option', { value: 'owner-a' }, 'Tenant A owner'),
        createElement('option', { value: 'owner-b' }, 'Tenant B owner'),
      ),
    ),
    createElement('button', { type: 'submit' }, 'Sign in'),
  )
}

export function SignOutButton({ children }: { children?: ReactNode }) {
  const submitButton = isValidElement(children)
    ? cloneElement(children as ReactElement<{ type?: 'button' | 'submit' | 'reset' }>, {
        type: 'submit',
      })
    : createElement('button', { type: 'submit' }, children ?? 'Sign out')
  return createElement('form', { method: 'post', action: '/sign-out' }, submitButton)
}

export function SignInButton({ children }: { children?: ReactNode }) {
  return createElement('a', { href: '/sign-in' }, children ?? 'Sign in')
}

export function useUser() {
  const identity = useFixtureIdentity()
  return {
    isLoaded: true,
    isSignedIn: identity !== null,
    user: identity
      ? {
          id: identity.userId,
          fullName: identity.selector === 'admin' ? 'Local Admin' : 'Synthetic Owner',
          firstName: identity.selector === 'admin' ? 'Local' : 'Synthetic',
          primaryEmailAddress: { emailAddress: `${identity.selector}@fixture.invalid` },
          publicMetadata: identity.platformAdmin ? { platform_role: 'PLATFORM_ADMIN' } : {},
        }
      : null,
  }
}

export function useOrganization() {
  const identity = useFixtureIdentity()
  return {
    isLoaded: true,
    organization: identity?.orgId
      ? { id: identity.orgId, name: identity.selector === 'owner-a' ? 'Tenant A' : 'Tenant B' }
      : null,
  }
}

export function useAuth() {
  const identity = useFixtureIdentity()
  return {
    isLoaded: true,
    isSignedIn: identity !== null,
    userId: identity?.userId ?? null,
    orgId: identity?.orgId ?? null,
  }
}

export function SignUp(): never {
  throw new Error('Organization sign-up is unavailable in local fixture auth')
}

export function OrganizationList(): never {
  throw new Error('Organization selection is unavailable in local fixture auth')
}

export function useOrganizationList(): never {
  throw new Error('Organization management is unavailable in local fixture auth')
}

export function useClerk(): never {
  throw new Error('Clerk client API is unavailable in local fixture auth')
}

/** Fixture sessions can never satisfy reverification; the server fails closed, so pass through. */
export function useReverification<T extends (...args: never[]) => unknown>(fetcher: T): T {
  return fetcher
}
