/**
 * Tab definitions shared by the server page and the client frame. This module must stay free of
 * 'use client': a server component that imports a value from a client module receives an opaque
 * client reference, and calling `.find` on it throws during server render.
 */
export const OPERATOR_TABS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'autonomy', label: 'Autonomy' },
  { id: 'connections', label: 'Connections' },
  { id: 'grants', label: 'Job grants' },
  { id: 'audit', label: 'Audit' },
] as const

export type OperatorTabId = (typeof OPERATOR_TABS)[number]['id']
