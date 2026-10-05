/** Public deployment switches only; never echo arbitrary environment values or errors. */
export const CUSTOMER_DEPLOYMENT_FLAGS = {
  'customers.propose_create': 'OPERATOR_CUSTOMER_CREATE_ENABLED',
  'customers.propose_invite': 'OPERATOR_CUSTOMER_INVITE_ENABLED',
} as const

type CustomerTool = keyof typeof CUSTOMER_DEPLOYMENT_FLAGS

export function customerDeploymentPrerequisite(tool: string) {
  if (!Object.hasOwn(CUSTOMER_DEPLOYMENT_FLAGS, tool)) return null
  const flag = CUSTOMER_DEPLOYMENT_FLAGS[tool as CustomerTool]
  return {
    flag,
    enabled: process.env[flag] === 'true',
    recoveryAction: `Ask the deployment owner to set ${flag}=true on the dashboard service in this environment through the normal configuration and deployment path. This does not change grants or approval requirements.`,
  }
}

export class OperatorDeploymentDisabledError extends Error {
  readonly code = 'DISABLED'
  /** Only plan preflight, after its existing-operation lookup, proves this. */
  operationRecorded?: false
  readonly details: {
    prerequisite: NonNullable<ReturnType<typeof customerDeploymentPrerequisite>>
    stepIndex?: number
    stepTool?: string
  }

  constructor(tool: CustomerTool) {
    const prerequisite = customerDeploymentPrerequisite(tool)!
    super(`${tool} requires ${prerequisite.flag}=true on this deployment.`)
    this.details = { prerequisite }
  }
}
