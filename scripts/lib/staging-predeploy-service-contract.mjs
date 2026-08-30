export const STAGING_MIGRATION_APPROVAL_VARIABLE = 'PATHFINDER_STAGING_MIGRATION_APPROVAL'
export const STAGING_MIGRATION_ONE_RUN_VARIABLE = 'PATHFINDER_ALLOW_STAGING_MIGRATIONS'

export function buildStagingPredeployServiceContract(approval) {
  if (!/^torchiko-staging-lineage-to-[a-z0-9-]+$/u.test(approval)) {
    throw new Error('staging-predeploy-service-approval-invalid')
  }
  return {
    service: 'web',
    requiredExactServiceVariables: {
      [STAGING_MIGRATION_APPROVAL_VARIABLE]: approval,
    },
    oneRunServiceVariable: {
      name: STAGING_MIGRATION_ONE_RUN_VARIABLE,
      admittedValue: '1',
      closedValue: '0',
    },
    imageEnvironmentIsNotServiceEnvironment: true,
  }
}
