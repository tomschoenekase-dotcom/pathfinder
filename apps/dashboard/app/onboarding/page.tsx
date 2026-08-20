'use client'

import { type FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { OrganizationList, SignOutButton, useClerk, useOrganizationList } from '@clerk/nextjs'
import { ArrowRight, Check, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react'

import { TorchikoBrand } from '@pathfinder/ui'

import styles from './onboarding.module.css'

export default function DashboardOnboardingPage() {
  const router = useRouter()
  const clerk = useClerk()
  const { isLoaded, userInvitations, userMemberships, setActive } = useOrganizationList({
    userInvitations: { infinite: true },
    userMemberships: { infinite: true },
  })
  const [orgName, setOrgName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null)
  const [invitationError, setInvitationError] = useState<string | null>(null)

  async function handleAcceptInvitation(
    invitation: NonNullable<typeof userInvitations.data>[number],
  ) {
    if (!setActive) return
    setAcceptingInvitationId(invitation.id)
    setInvitationError(null)
    try {
      await invitation.accept()
      await setActive({ organization: invitation.publicOrganizationData.id })
      router.replace('/')
    } catch (error) {
      setInvitationError(
        error instanceof Error ? error.message : 'The invitation could not be accepted. Try again.',
      )
      setAcceptingInvitationId(null)
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (!orgName.trim() || !setActive) return

    setIsCreating(true)
    setCreateError(null)

    try {
      const org = await clerk.createOrganization({ name: orgName.trim() })
      await setActive({ organization: org.id })
      router.replace('/')
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : 'Something went wrong. Please try again.',
      )
      setIsCreating(false)
    }
  }

  useEffect(() => {
    if (!isLoaded || !userMemberships.data) return

    const first = userMemberships.data[0]
    if (userMemberships.data.length === 1 && setActive && first) {
      void setActive({ organization: first.organization.id }).then(() => {
        router.replace('/')
      })
    }
  }, [isLoaded, userMemberships.data, setActive, router])

  if (
    !isLoaded ||
    userMemberships.isLoading ||
    userInvitations.isLoading ||
    (userMemberships.data && userMemberships.data.length === 1)
  ) {
    return (
      <main className={styles.page}>
        <section className={styles.loadingCard} aria-labelledby="loading-title" aria-live="polite">
          <span className={styles.loadingIcon}>
            <LoaderCircle aria-hidden="true" />
          </span>
          <p className={styles.eyebrow}>Torchiko</p>
          <h1 id="loading-title">Opening your workspace</h1>
          <p>Bringing your venue and latest progress into view.</p>
          <SignOutButton>
            <button type="button" className={styles.textButton}>
              Sign out
            </button>
          </SignOutButton>
        </section>
      </main>
    )
  }

  const hasMemberships = userMemberships.data && userMemberships.data.length > 0
  const hasInvitations = userInvitations.data && userInvitations.data.length > 0

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.storyPanel}>
          <div className={styles.brand}>
            <TorchikoBrand
              gapClassName="gap-2"
              textClassName="text-white"
              textSizeClassName="text-lg"
            />
          </div>
          <p className={styles.kicker}>Your venue, thoughtfully translated</p>
          <h1>A remarkable visitor guide starts with what you already have.</h1>
          <p className={styles.storyCopy}>
            Share the essentials, then add links, documents, photos, videos, and staff knowledge.
            Torchiko handles the difficult work and prepares a first preview for your approval.
          </p>
          <ul className={styles.promiseList}>
            <li>
              <Check aria-hidden="true" /> Modest input, professionally assembled
            </li>
            <li>
              <Check aria-hidden="true" /> Nothing goes live without review
            </li>
            <li>
              <ShieldCheck aria-hidden="true" /> Private and secure during setup
            </li>
          </ul>
        </section>

        <section className={styles.actionPanel} aria-labelledby="welcome-title">
          <span className={styles.sparkle}>
            <Sparkles aria-hidden="true" />
          </span>
          <p className={styles.eyebrow}>Welcome</p>
          <h2 id="welcome-title">Let&apos;s build your Torchiko experience.</h2>
          <p className={styles.actionCopy}>
            {hasMemberships
              ? 'Choose the organization you want to continue with.'
              : hasInvitations
                ? 'Your venue invitation is ready. Accept it here to begin onboarding.'
                : 'First, tell us the organization or venue name your visitors know.'}
          </p>
          <div className={styles.actionBody}>
            {hasMemberships ? (
              <OrganizationList
                hidePersonal
                afterSelectOrganizationUrl="/"
                afterCreateOrganizationUrl="/"
              />
            ) : hasInvitations ? (
              <div className={styles.invitationList}>
                {userInvitations.data?.map((invitation) => (
                  <article className={styles.invitationCard} key={invitation.id}>
                    <div>
                      <p className={styles.invitationLabel}>Invitation ready</p>
                      <h3>{invitation.publicOrganizationData.name}</h3>
                      <p>{invitation.emailAddress}</p>
                    </div>
                    <button
                      type="button"
                      disabled={acceptingInvitationId !== null}
                      className={styles.primaryButton}
                      onClick={() => void handleAcceptInvitation(invitation)}
                    >
                      {acceptingInvitationId === invitation.id ? (
                        <>
                          <LoaderCircle aria-hidden="true" /> Joining venue...
                        </>
                      ) : (
                        <>
                          Accept invitation <ArrowRight aria-hidden="true" />
                        </>
                      )}
                    </button>
                  </article>
                ))}
                {invitationError ? (
                  <p role="alert" className={styles.error}>
                    {invitationError}
                  </p>
                ) : null}
              </div>
            ) : (
              <form onSubmit={handleCreate}>
                <label htmlFor="organization-name">Organization or venue name</label>
                <input
                  id="organization-name"
                  name="organizationName"
                  type="text"
                  value={orgName}
                  onChange={(event) => setOrgName(event.target.value)}
                  autoFocus
                  autoComplete="organization"
                  className={styles.input}
                />
                <p className={styles.hint}>
                  You can update branding details when your first preview is ready.
                </p>
                {createError ? (
                  <p role="alert" className={styles.error}>
                    {createError}
                  </p>
                ) : null}
                <button
                  type="submit"
                  disabled={isCreating || !orgName.trim()}
                  className={styles.primaryButton}
                >
                  {isCreating ? (
                    <>
                      <LoaderCircle aria-hidden="true" /> Creating your private workspace...
                    </>
                  ) : (
                    <>
                      Continue <ArrowRight aria-hidden="true" />
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
          <SignOutButton>
            <button type="button" className={styles.textButton}>
              Sign out
            </button>
          </SignOutButton>
        </section>
      </div>
    </main>
  )
}
