export const STAGING_MIGRATION_APPROVAL_VARIABLE = 'PATHFINDER_STAGING_MIGRATION_APPROVAL'
export const STAGING_MIGRATION_ONE_RUN_VARIABLE = 'PATHFINDER_ALLOW_STAGING_MIGRATIONS'
export const STAGING_RELEASE_SHA_VARIABLE = 'PATHFINDER_RELEASE_SHA'

export function buildStagingPredeployServiceContract(approval, releaseSha) {
  if (!/^torchiko-staging-lineage-to-[a-z0-9-]+$/u.test(approval)) {
    throw new Error('staging-predeploy-service-approval-invalid')
  }
  if (releaseSha !== undefined && !/^[a-f0-9]{40}$/u.test(releaseSha)) {
    throw new Error('staging-predeploy-service-release-sha-invalid')
  }
  return {
    service: 'web',
    requiredExactServiceVariables: {
      [STAGING_MIGRATION_APPROVAL_VARIABLE]: approval,
      ...(releaseSha === undefined ? {} : { [STAGING_RELEASE_SHA_VARIABLE]: releaseSha }),
    },
    oneRunServiceVariable: {
      name: STAGING_MIGRATION_ONE_RUN_VARIABLE,
      admittedValue: '1',
      closedValue: '0',
    },
    imageEnvironmentIsNotServiceEnvironment: true,
  }
}
