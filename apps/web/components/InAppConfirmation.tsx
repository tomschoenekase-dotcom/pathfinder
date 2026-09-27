'use client'

import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { ChatPalette } from '@pathfinder/ui/theme'

import styles from './in-app-confirmation.module.css'

export type InAppConfirmationOptions = {
  title: string
  message: string
  cancelLabel: string
  confirmLabel: string
}

type PendingConfirmation = InAppConfirmationOptions & { id: number }
type ConfirmationRequest = (options: InAppConfirmationOptions) => Promise<boolean>

type ConfirmationController = {
  pending: PendingConfirmation | null
  requestConfirmation: ConfirmationRequest
  resolveConfirmation: (confirmed: boolean) => void
  returnFocusRef: RefObject<HTMLElement | null>
}

const ConfirmationContext = createContext<ConfirmationRequest>(() => Promise.resolve(false))

const CANCEL_LABELS: Record<SupportedChatLanguage, string> = {
  English: 'Cancel',
  Español: 'Cancelar',
  Français: 'Annuler',
  Deutsch: 'Abbrechen',
  Italiano: 'Annulla',
  Português: 'Cancelar',
  中文: '取消',
  日本語: 'キャンセル',
  한국어: '취소',
  العربية: 'إلغاء',
}

export function getConfirmationCancelLabel(language: SupportedChatLanguage): string {
  return CANCEL_LABELS[language] ?? CANCEL_LABELS.English
}

export function useInAppConfirmationController(): ConfirmationController {
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const nextIdRef = useRef(0)

  const requestConfirmation = useCallback<ConfirmationRequest>((options) => {
    resolverRef.current?.(false)
    returnFocusRef.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    return new Promise((resolve) => {
      resolverRef.current = resolve
      setPending({ ...options, id: ++nextIdRef.current })
    })
  }, [])

  const resolveConfirmation = useCallback((confirmed: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setPending(null)
    resolve?.(confirmed)
  }, [])

  useLayoutEffect(() => {
    const resolverOnUnmount = resolverRef
    return () => {
      resolverOnUnmount.current?.(false)
      resolverOnUnmount.current = null
    }
  }, [])

  return { pending, requestConfirmation, resolveConfirmation, returnFocusRef }
}

export function useRequestInAppConfirmation(): ConfirmationRequest {
  return useContext(ConfirmationContext)
}

export function InAppConfirmationProvider({
  children,
  controller,
  palette,
}: {
  children: ReactNode
  controller: ConfirmationController
  palette: ChatPalette
}) {
  return (
    <ConfirmationContext.Provider value={controller.requestConfirmation}>
      {children}
      {controller.pending ? (
        <ConfirmationDialog
          key={controller.pending.id}
          request={controller.pending}
          onResolve={controller.resolveConfirmation}
          returnFocusRef={controller.returnFocusRef}
          palette={palette}
        />
      ) : null}
    </ConfirmationContext.Provider>
  )
}

function ConfirmationDialog({
  request,
  onResolve,
  returnFocusRef,
  palette,
}: {
  request: PendingConfirmation
  onResolve: (confirmed: boolean) => void
  returnFocusRef: RefObject<HTMLElement | null>
  palette: ChatPalette
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const titleId = `visitor-confirmation-title-${request.id}`
  const messageId = `visitor-confirmation-message-${request.id}`
  const style = {
    '--confirm-background': palette.card,
    '--confirm-border': palette.border,
    '--confirm-text': palette.text,
    '--confirm-muted': palette.textMuted,
    '--confirm-accent': palette.accent,
    '--confirm-accent-text': palette.accentContrast,
  } as CSSProperties

  useLayoutEffect(() => {
    const returnTarget = returnFocusRef.current
    cancelRef.current?.focus({ preventScroll: true })
    return () => returnTarget?.focus({ preventScroll: true })
  }, [returnFocusRef])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onResolve(false)
      return
    }
    if (event.key !== 'Tab') return

    const cancel = cancelRef.current
    const confirm = confirmRef.current
    if (!cancel || !confirm) return
    if (event.shiftKey && document.activeElement === cancel) {
      event.preventDefault()
      confirm.focus()
    } else if (!event.shiftKey && document.activeElement === confirm) {
      event.preventDefault()
      cancel.focus()
    } else if (!dialogRef.current?.contains(document.activeElement)) {
      event.preventDefault()
      cancel.focus()
    }
  }

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        style={style}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {request.title}
        </h2>
        <p id={messageId} className={styles.message}>
          {request.message}
        </p>
        <div className={styles.actions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.cancel}
            onClick={() => onResolve(false)}
          >
            {request.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={styles.confirm}
            onClick={() => onResolve(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
