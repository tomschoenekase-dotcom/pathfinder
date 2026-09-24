// tRPC's default logger includes operation inputs, even on downstream errors.
// Provider writes carry plaintext keys until the server seals them.
const privatePayloadOperations = new Set([
  'admin.createAiProviderConnection',
  'admin.reviseAiProviderConnection',
  // CRM responses can contain private reply bodies, writing references and drafts.
  'admin.getProspectSalesWorkflow',
  'admin.prepareReviewProspectSales',
  'admin.readProspectReplyContent',
  'admin.retainProspectReplyContent',
])

export function shouldLogDashboardOperation(
  operation: { path?: string; direction: 'up' | 'down'; result?: unknown },
  development: boolean,
): boolean {
  if (!operation.path || privatePayloadOperations.has(operation.path)) return false
  return development || (operation.direction === 'down' && operation.result instanceof Error)
}
