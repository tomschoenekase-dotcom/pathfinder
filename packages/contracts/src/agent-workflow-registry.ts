import { z } from 'zod'

const key = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)
const capability = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/u)

export const AgentWorkflowPortableManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    registryKey: key,
    version: z.number().int().min(1).max(10_000),
    kind: z.enum(['SKILL', 'WORKFLOW']),
    description: z.string().trim().min(1).max(2_000),
    examples: z.array(z.string().trim().min(1).max(2_000)).max(10),
    requiredTools: z
      .array(z.object({ capability, reason: z.string().trim().min(1).max(500) }).strict())
      .max(50),
    testedCases: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
    rollback: z
      .object({
        registryKey: key,
        version: z.number().int().min(1).max(10_000),
        contentHash: sha256,
      })
      .strict()
      .nullable(),
    license: z.string().trim().min(1).max(191).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const capabilities = value.requiredTools.map((tool) => tool.capability)
    if (new Set(capabilities).size !== capabilities.length)
      context.addIssue({
        code: 'custom',
        path: ['requiredTools'],
        message: 'Required tools must be unique.',
      })
  })

export const AgentWorkflowProvenanceSchema = z
  .object({
    sourceType: z.enum(['HUMAN_AUTHORED', 'REVIEWED_AGENT_PROPOSAL', 'IMPORTED']),
    sourceReferences: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    capturedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()

export type AgentWorkflowPortableManifest = z.output<typeof AgentWorkflowPortableManifestSchema>
