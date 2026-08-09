import {
  parseStagingWidgetArgs,
  readReviewedWidgetSource,
  StagingWidgetAdmissionError,
  validateStagingWidgetInputs,
  verifyStagingWidget,
} from './lib/staging-widget-admission.mjs'

try {
  const rawInput = parseStagingWidgetArgs(process.argv.slice(2))
  const validatedInput = validateStagingWidgetInputs(rawInput)
  const reviewedWidgetSource = await readReviewedWidgetSource(validatedInput.expectedRevision)
  const result = await verifyStagingWidget({ ...rawInput, reviewedWidgetSource })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  const code = error instanceof StagingWidgetAdmissionError ? error.code : 'unexpected-failure'
  process.stderr.write(`Staging widget admission failed: ${code}\n`)
  process.exitCode = 1
}
