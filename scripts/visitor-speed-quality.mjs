#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const defaultQuestionsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'visitor-speed-questions.json',
)

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    )
  }
  return value
}

function fingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

function words(text) {
  return String(text ?? '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

function distribution(values) {
  if (!values.length) return { count: 0, min: null, median: null, p90: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(0.5),
    p90: percentile(0.9),
    max: sorted.at(-1),
  }
}

function validateRows(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} must be a JSON array`)
  const seen = new Set()
  for (const [index, row] of rows.entries()) {
    if (
      !row?.venue ||
      !row?.questionId ||
      !('modelInput' in row) ||
      typeof row.reply !== 'string'
    ) {
      throw new Error(`${label}[${index}] requires venue, questionId, modelInput, and string reply`)
    }
    const key = `${row.venue}\u0000${row.questionId}`
    if (seen.has(key)) throw new Error(`${label} contains duplicate ${row.venue}/${row.questionId}`)
    seen.add(key)
  }
  return new Map(rows.map((row) => [`${row.venue}\u0000${row.questionId}`, row]))
}

export function compare(beforeRows, afterRows, questionSet) {
  const before = validateRows(beforeRows, 'before')
  const after = validateRows(afterRows, 'after')
  const expectations = new Map(
    (questionSet ?? []).map((item) => [`${item.venue}\u0000${item.id}`, item.factualExpectations]),
  )
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
  const comparisons = []
  const factualFailures = []
  const coverageFailures = []
  let checkedExpectationCount = 0

  for (const key of keys) {
    const oldRow = before.get(key)
    const newRow = after.get(key)
    if (!oldRow || !newRow) {
      const status = oldRow ? 'missing-after' : 'missing-before'
      coverageFailures.push({ key: key.replace('\u0000', '/'), status })
      comparisons.push({ key: key.replace('\u0000', '/'), status })
      continue
    }
    const expectation = expectations.get(key)
    const checks = []
    if (expectation?.evidence && Array.isArray(expectation.requiredPhrases)) {
      checkedExpectationCount += 1
      const answer = newRow.reply.toLocaleLowerCase()
      const missing = expectation.requiredPhrases.filter(
        (phrase) => !answer.includes(String(phrase).toLocaleLowerCase()),
      )
      const forbidden = (expectation.forbiddenPhrases ?? []).filter((phrase) =>
        answer.includes(String(phrase).toLocaleLowerCase()),
      )
      checks.push({
        evidence: expectation.evidence,
        missingRequiredPhrases: missing,
        forbiddenPhrasesPresent: forbidden,
      })
      if (missing.length || forbidden.length)
        factualFailures.push({ key: key.replace('\u0000', '/'), ...checks.at(-1) })
    }
    comparisons.push({
      key: key.replace('\u0000', '/'),
      modelInputFingerprintChanged:
        fingerprint(oldRow.modelInput) !== fingerprint(newRow.modelInput),
      replyChanged: oldRow.reply !== newRow.reply,
      beforeWords: words(oldRow.reply),
      afterWords: words(newRow.reply),
      expectationChecks: checks,
    })
  }

  const venues = [
    ...new Set([...before.values(), ...after.values()].map((row) => row.venue)),
  ].sort()
  const wordCounts = Object.fromEntries(
    venues.map((venue) => [
      venue,
      {
        before: distribution(
          [...before.values()].filter((row) => row.venue === venue).map((row) => words(row.reply)),
        ),
        after: distribution(
          [...after.values()].filter((row) => row.venue === venue).map((row) => words(row.reply)),
        ),
      },
    ]),
  )
  const questionKeys = new Set((questionSet ?? []).map((item) => `${item.venue}\u0000${item.id}`))
  const uncoveredQuestions = [...questionKeys]
    .filter((key) => !before.has(key) || !after.has(key))
    .map((key) => ({
      key: key.replace('\u0000', '/'),
      missingBefore: !before.has(key),
      missingAfter: !after.has(key),
    }))
  const factualRegressionGate = factualFailures.length
    ? 'FAIL'
    : coverageFailures.length || uncoveredQuestions.length
      ? 'INCOMPLETE_ANSWER_COVERAGE'
      : checkedExpectationCount
        ? 'PASS_FOR_ANNOTATED_EXPECTATIONS'
        : 'PENDING_NO_SOURCE_BACKED_EXPECTATIONS'
  return {
    schemaVersion: 1,
    factualRegressionGate,
    expectationChecks: checkedExpectationCount,
    factualFailures,
    coverageFailures,
    uncoveredQuestions,
    comparisons,
    wordCounts,
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: node scripts/visitor-speed-quality.mjs --before before.json --after after.json [--questions questions.json] [--out report.json]\n       node scripts/visitor-speed-quality.mjs --self-check',
    )
    return
  }
  if (args.includes('--self-check')) {
    const questionSet = [
      {
        venue: 'Fixture Venue',
        id: 'q1',
        factualExpectations: {
          evidence: 'fixture source: approved phrase',
          requiredPhrases: ['approved phrase'],
          forbiddenPhrases: ['invented claim'],
        },
      },
    ]
    const report = compare(
      [
        {
          venue: 'Fixture Venue',
          questionId: 'q1',
          modelInput: [{ role: 'user', content: 'Question' }],
          reply: 'The approved phrase is here.',
        },
      ],
      [
        {
          venue: 'Fixture Venue',
          questionId: 'q1',
          modelInput: [{ role: 'user', content: 'Question with retrieval update' }],
          reply: 'The approved phrase is here, briefly.',
        },
      ],
      questionSet,
    )
    if (
      report.factualRegressionGate !== 'PASS_FOR_ANNOTATED_EXPECTATIONS' ||
      !report.comparisons[0].modelInputFingerprintChanged ||
      !report.comparisons[0].replyChanged
    ) {
      throw new Error('Self-check failed: fingerprint/reply/expectation behavior is incorrect')
    }
    console.log(
      JSON.stringify(
        {
          selfCheck: 'PASS',
          gate: report.factualRegressionGate,
          fingerprintChanged: report.comparisons[0].modelInputFingerprintChanged,
          replyChanged: report.comparisons[0].replyChanged,
          wordCounts: report.wordCounts,
        },
        null,
        2,
      ),
    )
    return
  }
  const valueFor = (name, required = true) => {
    const index = args.indexOf(`--${name}`)
    if (index < 0) {
      if (required) throw new Error(`Missing --${name}`)
      return undefined
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`)
    return value
  }
  const [beforePath, afterPath] = [valueFor('before'), valueFor('after')]
  const questionsPath = valueFor('questions', false) ?? defaultQuestionsPath
  const [beforeRows, afterRows, questionSet] = await Promise.all(
    [beforePath, afterPath, questionsPath].map(async (filename) =>
      JSON.parse(await readFile(filename, 'utf8')),
    ),
  )
  const report = compare(beforeRows, afterRows, questionSet)
  const output = `${JSON.stringify(report, null, 2)}\n`
  const outPath = valueFor('out', false)
  if (outPath) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outPath, output, 'utf8')
  } else process.stdout.write(output)
  if (report.factualRegressionGate === 'FAIL') process.exitCode = 1
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
