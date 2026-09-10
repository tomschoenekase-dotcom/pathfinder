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
    migrationOnlyHold: {
      name: 'PATHFINDER_STAGING_MIGRATION_ONLY_HOLD',
      heldValue: '1',
      releasedValue: '0',
      unsetValue: '0',
      pendingPreservedDataRequiresHold: true,
      verifiedHeldExitCode: 2,
      verifiedHeldDeploymentStatus: 'FAILED',
      codeOnlyRequiresMigrationOptIn: '0',
      releaseRequiresManualSameRevisionDeploy: true,
    },
    imageEnvironmentIsNotServiceEnvironment: true,
  }
}
