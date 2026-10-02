'use client'

import { useReverification } from '@clerk/nextjs'

export type OperatorJson = { error?: string; [key: string]: unknown }

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // The parsed body is returned as is: on a 403 it carries Clerk's reverification hint, which
  // useReverification recognises before it retries the call after Face ID or a passkey.
  return (await response.json()) as OperatorJson
}

/**
 * Every operator state change is a POST to a guarded route handler. Clerk asks for Face ID or a
 * passkey when the handler answers with the strict reverification hint, then repeats the call.
 */
export function useOperatorPost(path: string) {
  return useReverification((body: unknown) => postJson(path, body))
}

const ERROR_TEXT: Record<string, string> = {
  ARGS_HASH_MISMATCH:
    'This request changed after you opened it. Reload the page to review it again.',
  NOT_PENDING: 'This request was already decided.',
  NOT_FOUND: 'Not found. It may have been removed.',
  FORBIDDEN: 'This account is not allowed to do that.',
  FORBIDDEN_ORIGIN: 'The request came from an unexpected address.',
  OPERATOR_UNAVAILABLE: 'The operator is not fully configured.',
  AUTONOMY_LOCKED: 'That capability always asks and cannot be switched.',
  INVALID_REQUEST: 'The request was not valid.',
  PLAN_STEP: 'Decide the whole plan, not one step.',
  REQUEST_EXPIRED: 'This approval request expired. Ask for it again in the chat.',
  REQUEST_USED: 'This approval request was already used.',
  REQUEST_INVALIDATED: 'The proposal changed after it was requested. Ask for it again in the chat.',
  FORBIDDEN_ACTOR: 'This account is not allowed to do that.',
  KIND_NOT_GRANTABLE: 'That action cannot be granted.',
  CLIENT_NOT_FOUND: 'That connected app is not active.',
  SCOPE_NOT_FOUND: 'That client or venue was not found.',
  NO_MATCHING_GRANT: 'No active job grant you created covers this change. It remains pending.',
  INVALID: 'One of the limits is out of range.',
}

export function errorText(code: string | undefined) {
  return (code && ERROR_TEXT[code]) || 'Nothing changed.'
}

export const CANCELLED_TEXT = 'Verification was cancelled. Nothing changed.'
