#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  validateAnswerQuestions,
  buildAnswerScenarios,
  gradeVenueAnswer,
  precheckAnswerFacts,
  sha256,
} from './guest-query-evaluation-contract.mjs'
import { renderVenueAnswerReview } from './guest-query-evaluation-driver.mjs'
import { runVisitorScenarios } from './visitor-speed-harness.mjs'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export async function answerTest(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') {
      console.log(
        'pnpm venue:answer-test --questions FILE --out NEW_DIR [--url GUEST_LINK] [--offline PACKAGE] [--viewport mobile|desktop]',
      )
      return
    }
    if (
      !['--url', '--questions', '--out', '--offline', '--viewport'].includes(argv[i]) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--')
    )
      throw new Error(`Invalid option: ${argv[i]}`)
    if (options[argv[i].slice(2)]) throw new Error(`Duplicate option: ${argv[i]}`)
    options[argv[i].slice(2)] = argv[++i]
  }
  if (!options.questions || !options.out || (!options.url && !options.offline))
    throw new Error('--questions, --out, and --url or --offline required')
  if (options.url && !['http:', 'https:'].includes(new URL(options.url).protocol))
    throw new Error('URL must be HTTP(S)')
  if (options.viewport && !['mobile', 'desktop'].includes(options.viewport))
    throw new Error('viewport must be mobile or desktop')
  const bytes = await readFile(path.resolve(options.questions), 'utf8')
  const questions = validateAnswerQuestions(JSON.parse(bytes.replace(/^\uFEFF/u, '')))
  const outDir = path.resolve(options.out)
  // Never overwrite an earlier run.
  await mkdir(path.dirname(outDir), { recursive: true })
  await mkdir(outDir)
  const result = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: 'running',
    questionFileSha256: sha256(bytes),
    guideUrl: options.url || null,
    viewport: options.viewport || 'desktop',
    questions,
    answers: [],
    precheck: null,
  }
  const save = async () => {
    await writeFile(path.join(outDir, 'results.json'), JSON.stringify(result, null, 2) + '\n')
    await writeFile(path.join(outDir, 'REVIEW.md'), renderVenueAnswerReview(result))
  }
  try {
    if (options.offline) {
      const packagePath = path.resolve(options.offline)
      const packageBytes = await readFile(packagePath)
      const checks = []
      // Different venue-local dates may render different dated material.
      for (const date of [
        ...new Set(
          questions.map((row) =>
            new Intl.DateTimeFormat('en-CA', {
              timeZone: row.timeZone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(new Date(row.askedAt)),
          ),
        ),
      ]) {
        const rendered = spawnSync(
          process.execPath,
          [
            path.join(repoRoot, 'packages/db/node_modules/tsx/dist/cli.mjs'),
            path.join(repoRoot, 'scripts/venue-answer-preview.ts'),
            packagePath,
            date,
          ],
          { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, cwd: repoRoot },
        )
        if (rendered.status !== 0)
          throw new Error(
            `Offline guide preview failed: ${rendered.stderr || rendered.error || rendered.stdout}`,
          )
        const preview = JSON.parse(rendered.stdout)
        const subset = questions.filter(
          (row) =>
            new Intl.DateTimeFormat('en-CA', {
              timeZone: row.timeZone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(new Date(row.askedAt)) === date,
        )
        checks.push({
          date,
          mode: preview.default.mode,
          rendererTruncated: preview.default.rendererTruncated,
          ...precheckAnswerFacts(subset, preview.default.renderedText),
        })
      }
      result.precheck = {
        status: checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
        packageSha256: sha256(packageBytes),
        checks,
        scope:
          'Offline fact presence only; no live visibility, completeness or factual verification',
      }
      if (result.precheck.status === 'fail') {
        result.status = 'precheck-failed'
        process.exitCode = 1
        return result
      }
    }
    if (!options.url) {
      result.status = 'offline-only'
      return result
    }
    const turns = await runVisitorScenarios({
      guideUrl: options.url,
      scenarios: buildAnswerScenarios(questions),
      outDir,
      viewport: result.viewport,
      projectRoot: repoRoot,
      onTurn: async (turn) => {
        const question = questions.find((row) => row.id === turn.questionId)
        const grade = gradeVenueAnswer(question, turn)
        if (turn.screenshotError && grade.status === 'pass') {
          grade.status = 'needs-human'
          grade.reasons.push('Screenshot failed')
        }
        result.answers.push({ ...turn, question, grade })
        await save()
      },
    })
    // runVisitorScenarios persists each completed turn through onTurn.
    result.turnCount = turns.length
    result.status = result.answers.some((row) => row.grade.status === 'fail')
      ? 'fail'
      : result.answers.some((row) => row.grade.status === 'needs-human')
        ? 'needs-human'
        : 'pass'
    if (result.status !== 'pass') process.exitCode = 1
    return result
  } catch (error) {
    result.status = 'error'
    result.error = error.message
    throw error
  } finally {
    result.finishedAt = new Date().toISOString()
    await save()
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  answerTest(process.argv.slice(2))
    .then((result) => {
      if (result) console.log(`Answer test: ${result.status}`)
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
