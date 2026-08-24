import { z } from 'zod'

export const agentApprovalPolicyKey = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
