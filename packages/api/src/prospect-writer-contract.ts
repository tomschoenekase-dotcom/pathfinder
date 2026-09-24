import { z } from 'zod'
import { salesMeaningInput } from './prospect-meaning-contract'
const id = z.string().min(1).max(191)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const model = z
  .object({ kind: z.literal('model'), identity: z.string().trim().min(1).max(191) })
  .strict()
export const writerBinding = z
  .object({
    launchAttachmentsSha256: hash.optional(),
    venueId: id,
    organizationId: id,
    preparationId: id,
    nativeSnapshotHash: hash,
    preparationHash: hash,
    componentCodeHash: hash,
    fileSetHash: hash,
    selectionId: id.nullable(),
    routeHash: hash,
    routeKind: z.enum(['email', 'contact_form']),
    recipient: z.string().max(320).nullable(),
    formUrl: z.string().max(2000).nullable(),
    threadHash: hash,
    libraryHash: hash,
    wltHash: hash,
    expectedDraftId: id.nullable(),
    expectedVenueDraftId: id.nullable(),
    expectedMeaningReviewId: id.nullable(),
    expectedReadReviewId: id.nullable(),
  })
  .strict()
export const nativeWriterResult = z
  .object({
    schema: z.literal('torchiko.native-writer-result/1'),
    taskId: z.string().regex(/^writer-task_[a-f0-9]{64}$/u),
    binding: writerBinding,
    generatedBy: model,
    subject: z
      .string()
      .min(1)
      .max(160)
      .refine((v) => !/[\r\n\0]/u.test(v)),
    body: z
      .string()
      .min(1)
      .max(12000)
      .refine((v) => !/[\r\0]/u.test(v)),
    annotations: salesMeaningInput.shape.annotations,
    languageUses: salesMeaningInput.shape.languageUses,
    assessment: z
      .object({
        reviewer: model,
        assessments: salesMeaningInput.shape.assessments,
        answers: salesMeaningInput.shape.answers,
        unsupportedClaims: salesMeaningInput.shape.unsupportedClaims,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 60_000)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Writer result exceeds 60,000 UTF-8 bytes',
      })
    const ids = new Set<string>()
    for (const section of ['subject', 'body'] as const) {
      const points = Array.from(value[section]),
        coverage = new Uint8Array(points.length)
      for (const a of value.annotations.filter((a) => a.section === section)) {
        if (
          ids.has(a.annotation_id) ||
          a.start >= a.end ||
          a.end > points.length ||
          points.slice(a.start, a.end).join('') !== a.quote
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Exact unique Unicode code-point spans required',
          })
        ids.add(a.annotation_id)
        for (let n = a.start; n < Math.min(a.end, points.length); n++) coverage[n]!++
      }
      if (points.some((p, n) => coverage[n]! > 1 || (/\S/u.test(p) && coverage[n] !== 1)))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Annotation spans must cover every non-whitespace character once, without overlap',
        })
    }
  })
export const writerImportInput = z
  .object({ venueId: id, expectedSnapshotHash: hash, result: nativeWriterResult })
  .strict()
  .refine(
    (v) =>
      v.venueId === v.result.binding.venueId &&
      v.expectedSnapshotHash === v.result.binding.nativeSnapshotHash,
    'Result must target the exact exported venue and source snapshot',
  )
export type NativeWriterResult = z.infer<typeof nativeWriterResult>
export type { NativeWriterTask } from '@pathfinder/db'
