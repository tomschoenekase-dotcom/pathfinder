'use client'

import { useId } from 'react'
import { Check, ArrowRight } from 'lucide-react'

import styles from './IntakeV1ReviewPanel.module.css'

export type IntakeV1ReviewSource = {
  key: string
  group: 'draft' | 'source' | 'upload'
  label: string
  detail: string
}

export type IntakeV1ReviewReceipt = {
  revision: number
  includedCount: number | null
  excludedDescriptions: string[]
}

type Props = {
  phase: 'editing' | 'preparing' | 'reviewing' | 'submitting'
  sources: IntakeV1ReviewSource[]
  selectedKeys: ReadonlySet<string>
  partialAcknowledged: boolean
  receipt: IntakeV1ReviewReceipt | null
  loadingReceipt?: boolean
  error: string | null
  retryUncertain: boolean
  moreSources: boolean
  moreUploads: boolean
  loadingMore: boolean
  onPrepare: () => void
  onToggle: (key: string) => void
  onPartialAcknowledged: (value: boolean) => void
  onBack: () => void
  onSubmit: () => void
  onLoadMoreSources: () => void
  onLoadMoreUploads: () => void
}

const groups = [
  { kind: 'draft', title: 'Your private drafts' },
  { kind: 'source', title: 'Previously shared information' },
  { kind: 'upload', title: 'Uploaded files' },
] as const

/** Presentation only; the coordinating workspace owns snapshot and retry identities. */
export function IntakeV1ReviewPanel(props: Props) {
  const titleId = useId()
  const reviewOpen = props.phase === 'reviewing' || props.phase === 'submitting'
  const busy = props.phase === 'preparing' || props.phase === 'submitting'
  const selectedCount = props.selectedKeys.size
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <div className={styles.heading}>
        <p className={styles.eyebrow}>
          {props.receipt ? 'Your next version' : 'Your first version'}
        </p>
        <h2 id={titleId}>
          {reviewOpen ? 'Choose what goes into this version.' : 'Ready to send your materials?'}
        </h2>
        <p>
          {reviewOpen
            ? props.receipt
              ? 'Your latest edits are saved. This version will include only the items selected below.'
              : 'Your latest edits are saved. Choose the material you want Torchiko to review together.'
            : 'Send a saved version for Torchiko to review. You can return and add an update later.'}
        </p>
      </div>

      {props.loadingReceipt ? <p role="status">Loading your saved submission…</p> : null}
      {props.receipt ? (
        <div className={styles.receipt} role="status">
          <Check aria-hidden="true" size={20} />
          <div>
            <strong>Version {props.receipt.revision} received</strong>
            <p>
              {props.receipt.includedCount === null
                ? 'Your material is saved for review.'
                : `${props.receipt.includedCount} selected item${props.receipt.includedCount === 1 ? '' : 's'} saved for review.`}{' '}
              Visitor content has not been published by this submission.
            </p>
            {props.receipt.excludedDescriptions.length ? (
              <ul>
                {props.receipt.excludedDescriptions.map((description, index) => (
                  <li key={`${index}:${description}`}>{description}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      {reviewOpen ? (
        <>
          <fieldset className={styles.selection} disabled={busy || props.retryUncertain}>
            <legend className={styles.selectionLegend}>{selectedCount} of 50 items selected</legend>
            {groups.map((group) => {
              const sources = props.sources.filter((source) => source.group === group.kind)
              if (!sources.length) return null
              return (
                <div className={styles.group} key={group.kind}>
                  <h3>{group.title}</h3>
                  {sources.map((source) => {
                    const checked = props.selectedKeys.has(source.key)
                    return (
                      <label className={styles.source} key={source.key}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && selectedCount >= 50}
                          onChange={() => props.onToggle(source.key)}
                        />
                        <span>
                          <strong>{source.label}</strong>
                          <span className={styles.detail}>{source.detail}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )
            })}
            {!props.sources.length ? (
              <p className={styles.empty}>
                {props.retryUncertain
                  ? 'Your previous selection is preserved. Check its receipt before making changes.'
                  : 'Add a website, a note, staff answers, or a file first.'}
              </p>
            ) : null}
            {props.moreSources || props.moreUploads ? (
              <div className={styles.more}>
                {props.moreSources ? (
                  <button
                    type="button"
                    disabled={props.loadingMore}
                    onClick={props.onLoadMoreSources}
                  >
                    Load more shared information
                  </button>
                ) : null}
                {props.moreUploads ? (
                  <button
                    type="button"
                    disabled={props.loadingMore}
                    onClick={props.onLoadMoreUploads}
                  >
                    Load more files
                  </button>
                ) : null}
              </div>
            ) : null}
            <label className={styles.partial}>
              <input
                type="checkbox"
                checked={props.partialAcknowledged}
                onChange={(event) => props.onPartialAcknowledged(event.target.checked)}
              />
              <span>
                <strong>Send what is complete</strong>
                <span className={styles.detail}>
                  Leave incomplete drafts private and leave files that are still being checked out
                  of this version. The receipt will show anything left out.
                </span>
              </span>
            </label>
          </fieldset>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              type="button"
              disabled={
                busy ||
                props.loadingReceipt ||
                selectedCount === 0 ||
                selectedCount > 50 ||
                props.loadingMore
              }
              onClick={props.onSubmit}
            >
              {busy
                ? 'Saving your submission…'
                : props.retryUncertain
                  ? 'Check this submission again'
                  : props.receipt
                    ? 'Submit this update'
                    : 'Submit this version'}
              {!busy ? <ArrowRight aria-hidden="true" size={17} /> : null}
            </button>
            <button
              className={styles.secondary}
              type="button"
              disabled={busy || props.retryUncertain}
              onClick={props.onBack}
            >
              Back to editing
            </button>
          </div>
        </>
      ) : (
        <button
          className={styles.primary}
          type="button"
          disabled={busy || props.loadingReceipt}
          onClick={props.onPrepare}
        >
          {busy
            ? 'Saving your latest edits…'
            : props.receipt
              ? 'Review an update'
              : 'Review my materials'}
          {!busy ? <ArrowRight aria-hidden="true" size={17} /> : null}
        </button>
      )}
      {props.error ? (
        <p className={styles.error} role="alert">
          {props.error}
        </p>
      ) : null}
    </section>
  )
}
