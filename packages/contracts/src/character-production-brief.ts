import { z } from 'zod'

import { RuntimePackStateSchema } from './character-runtime-pack'

const Id = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .max(100)
const NonEmpty = z.string().trim().min(1).max(500)

export const CharacterProviderRequirementSchema = z
  .object({
    capability: z.enum([
      'reference-image-input',
      'image-generation',
      'commercial-use-review',
      'transparent-or-removable-background',
    ]),
    required: z.boolean(),
    limitation: NonEmpty,
  })
  .strict()

export const CharacterProductionBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    briefId: Id,
    characterId: Id,
    displayName: z.string().trim().min(1).max(120),
    houseStyle: z
      .object({
        id: Id,
        version: z.string().trim().min(1).max(80),
        visualThesis: z.string().trim().min(1).max(1_500),
        positiveAnchors: z.array(NonEmpty).min(1).max(20),
        weakExamples: z.array(NonEmpty).max(20),
      })
      .strict(),
    approvedReference: z
      .object({
        fileName: z
          .string()
          .regex(/^[^/\\]+\.(?:png|jpg|jpeg|webp)$/iu)
          .max(180),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        byteLength: z
          .number()
          .int()
          .positive()
          .max(20 * 1024 * 1024),
        authority: z.literal('founder-approved-reference-board'),
        repositoryState: z.literal('operator-supplied-by-hash'),
        usage: z.string().trim().min(1).max(1_000),
      })
      .strict(),
    creation: z
      .object({
        mode: z.literal('reference-conditioned-agent-assisted'),
        factoryIntake: z.literal('CREATE_FROM_IMPORT'),
        automaticGenerationAvailable: z.literal(false),
        providerRequirements: z.array(CharacterProviderRequirementSchema).min(1).max(10),
      })
      .strict(),
    identity: z
      .object({
        concept: z.string().trim().min(1).max(1_000),
        lockedTraits: z.array(NonEmpty).min(1).max(40),
        requestedChanges: z.array(NonEmpty).max(20),
        forbiddenTraits: z.array(NonEmpty).min(1).max(40),
        expressions: z.array(NonEmpty).min(1).max(20),
      })
      .strict(),
    productionMaster: z
      .object({
        acceptedMediaTypes: z
          .array(z.enum(['image/png', 'image/svg+xml']))
          .min(1)
          .max(2),
        transparentBackgroundPreferred: z.boolean(),
        separateOptionalEffects: z.boolean(),
        requirements: z.array(NonEmpty).min(1).max(30),
      })
      .strict(),
    motionProfile: z
      .object({
        family: z.literal('morph-v1'),
        targetCapability: z.literal('deformable-contour'),
        initialStates: z.array(RuntimePackStateSchema).min(1).max(14),
        requiredBehavior: z.array(NonEmpty).min(1).max(30),
        reducedMotionFallbackRequired: z.literal(true),
      })
      .strict(),
    review: z
      .object({
        humanApprovalRequired: z.literal(true),
        publishable: z.literal(false),
        gates: z.array(NonEmpty).min(1).max(30),
      })
      .strict(),
  })
  .strict()
  .superRefine((brief, context) => {
    if (new Set(brief.identity.lockedTraits).size !== brief.identity.lockedTraits.length)
      context.addIssue({ code: 'custom', message: 'Locked traits must be unique.' })
    if (new Set(brief.identity.expressions).size !== brief.identity.expressions.length)
      context.addIssue({ code: 'custom', message: 'Expressions must be unique.' })
    if (
      new Set(brief.motionProfile.initialStates).size !== brief.motionProfile.initialStates.length
    )
      context.addIssue({ code: 'custom', message: 'Initial motion states must be unique.' })
  })

export type CharacterProductionBrief = z.infer<typeof CharacterProductionBriefSchema>

/**
 * Provider-neutral handoff text. The caller must attach the byte-matched reference image;
 * naming a file here is not visual conditioning by itself.
 */
export function createCharacterProductionPrompt(input: CharacterProductionBrief): string {
  const brief = CharacterProductionBriefSchema.parse(input)
  return [
    `Create one production candidate for ${brief.displayName} (${brief.characterId}).`,
    '',
    'REFERENCE REQUIREMENT',
    `Attach ${brief.approvedReference.fileName} and verify SHA-256 ${brief.approvedReference.sha256}.`,
    'If the selected tool cannot receive that image, stop and report a text-only fallback; do not claim reference-conditioned generation.',
    '',
    'HOUSE STYLE',
    brief.houseStyle.visualThesis,
    `Positive anchors: ${brief.houseStyle.positiveAnchors.join('; ')}.`,
    `Known weak examples: ${brief.houseStyle.weakExamples.join('; ') || 'none recorded'}.`,
    '',
    'CHARACTER IDENTITY',
    brief.identity.concept,
    `Lock: ${brief.identity.lockedTraits.join('; ')}.`,
    `Change only: ${brief.identity.requestedChanges.join('; ') || 'no changes requested'}.`,
    `Do not: ${brief.identity.forbiddenTraits.join('; ')}.`,
    `Expression evidence: ${brief.identity.expressions.join(', ')}.`,
    '',
    'OUTPUT',
    `Accepted master formats: ${brief.productionMaster.acceptedMediaTypes.join(', ')}.`,
    `Transparent background: ${brief.productionMaster.transparentBackgroundPreferred ? 'preferred' : 'not required'}.`,
    `Optional effects on separate layers: ${brief.productionMaster.separateOptionalEffects ? 'required where the selected tool supports layers' : 'not required'}.`,
    brief.productionMaster.requirements.join(' '),
    'Return a clean isolated master, not a poster, logo lockup, labeled sheet, or finished publication.',
    'Do not publish or replace any active character. Human approval of the exact artifact is required.',
  ].join('\n')
}
