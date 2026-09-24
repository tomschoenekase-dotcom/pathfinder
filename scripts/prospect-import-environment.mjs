export const LOCAL_CRM_DATABASE = 'pathfinder_disposable_crm_research_20260919'
export const LOCAL_CRM_PORT = '58617'
export const CANONICAL_WORKBOOK_SHA256 =
  '1e2d5c29aae124a616e5c037e9e75cfc4f35026ec838dbd39914a3bd8aa1d8ff'

function localTarget(value) {
  let target
  try {
    target = new URL(value ?? '')
  } catch {
    throw new Error('An explicit local CRM database URL is required')
  }
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.port !== LOCAL_CRM_PORT ||
    target.pathname !== `/${LOCAL_CRM_DATABASE}` ||
    target.search ||
    target.hash
  ) {
    throw new Error(
      'CRM import is restricted to the retained loopback research database on port 58617',
    )
  }
  return { host: target.hostname, port: target.port, database: LOCAL_CRM_DATABASE }
}

export function assertLocalProspectImportEnvironment(env) {
  if (
    env.NODE_ENV === 'production' ||
    env.DEPLOYMENT_ENV === 'production' ||
    env.APP_ENV === 'production'
  ) {
    throw new Error('Production CRM import is not authorized by this local research command')
  }
  const target = localTarget(env.DATABASE_URL)
  if (env.DIRECT_DATABASE_URL) localTarget(env.DIRECT_DATABASE_URL)
  return target
}

export function assertSourceOnlyWorkbookPackage(value) {
  if (value.sourceWorkbook.sha256 !== CANONICAL_WORKBOOK_SHA256) {
    throw new Error('Local commit requires the exact reviewed canonical workbook hash')
  }
  for (const record of value.records) {
    if (
      !['PROSPECT', 'CONTACT', 'EVIDENCE'].includes(record.kind) ||
      record.status !== 'SOURCE_ONLY_UNVERIFIED'
    ) {
      throw new Error(
        'This local importer admits source-only prospects, contacts and evidence, never drafts or campaigns',
      )
    }
    if (
      record.kind === 'PROSPECT' &&
      (record.normalized.duplicateOutcome !== 'KEEP_DISTINCT' ||
        record.normalized.existingOrganizationId ||
        record.normalized.existingVenueId)
    ) {
      throw new Error('This local import cannot update or relink existing prospect records')
    }
  }
}
