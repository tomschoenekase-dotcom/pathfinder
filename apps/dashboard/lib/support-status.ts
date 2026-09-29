// Client-facing wording for Help conversation states, shared by Home and Help.
export const SUPPORT_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Received',
  WAITING_FOR_CLIENT: 'Waiting for your reply',
  IN_REVIEW: 'In review',
  PATCH_DRAFTED: 'Preparing an update',
  VALIDATING: 'Checking the update',
  AWAITING_APPROVAL: 'Awaiting approval',
  APPLYING: 'Updating your guide',
  COMPLETED: 'Completed',
  CANCELLED: 'Closed',
}

export function supportStatusLabel(status: string) {
  return SUPPORT_STATUS_LABELS[status] ?? 'In progress'
}
