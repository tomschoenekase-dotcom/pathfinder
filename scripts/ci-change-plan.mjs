#!/usr/bin/env node
// Computes the CI change plan for the checked-out revision and writes it as GitHub step outputs,
// a JSON artifact and a human summary. Any failure degrades to the FULL plan and exits 0, so a
// classifier problem can only ever cost time, never skip a gate.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  UnsafeClassification,
  fullPlan,
  parseNameStatusZ,
  planToOutputs,
  renderExplanation,
  safePlan,
  forcedFullReason,
} from './lib/ci-change-plan.mjs'

const SHA = /^[0-9a-f]{40}$/u
const ZERO_SHA = /^0{40}$/u
const MAX_BUFFER = 256 * 1024 * 1024

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
    ...options,
  })
  if (result.error) throw new UnsafeClassification(`git ${args[0]} failed: ${result.error.code}`)
  return result
}

function gitOk(args) {
  const result = git(args)
  if (result.status !== 0) {
    throw new UnsafeClassification(`git ${args[0]} exited ${result.status}`)
  }
  return result.stdout
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new UnsafeClassification(`bad argument ${key}`)
    }
    options[key.slice(2)] = value
  }
  return options
}

function resolveBase(options, event) {
  if (event === 'pull_request') {
    if (!SHA.test(options['base-sha'] ?? '')) throw new UnsafeClassification('missing PR base sha')
    return options['base-sha']
  }
  // Push on a development branch: compare the whole branch with master, not just the last push,
  // so earlier unverified commits can never be hidden behind a docs-only tip.
  const remote = options['default-branch-ref'] ?? 'refs/remotes/origin/master'
  const resolved = git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`])
  if (resolved.status !== 0) throw new UnsafeClassification('default branch ref not fetched')
  return resolved.stdout.trim()
}

function collectChanges(options, event) {
  if (gitOk(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
    throw new UnsafeClassification('shallow history: merge base cannot be proven')
  }
  const head = gitOk(['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  const base = resolveBase(options, event)
  if (ZERO_SHA.test(base) || git(['cat-file', '-e', `${base}^{commit}`]).status !== 0) {
    throw new UnsafeClassification('base commit is not present in the fetched history')
  }
  const mergeBase = git(['merge-base', base, head])
  if (mergeBase.status !== 0 || !SHA.test(mergeBase.stdout.trim())) {
    throw new UnsafeClassification('no merge base between base and head')
  }
  const from = mergeBase.stdout.trim()
  const raw = gitOk(['diff', '--name-status', '-M', '-z', '--no-ext-diff', from, head])
  const entries = parseNameStatusZ(raw)
  // Independent cross-check of the record count guards against a silently truncated listing.
  const stat = gitOk(['diff', '--shortstat', '-M', '--no-ext-diff', from, head]).trim()
  const expected = stat === '' ? 0 : Number(/^(\d+) files? changed/u.exec(stat)?.[1])
  if (!Number.isInteger(expected) || expected !== entries.length) {
    throw new UnsafeClassification(
      `diff cross-check failed (${entries.length} listed, ${stat || 'no stat'})`,
    )
  }
  return entries
}

function repositoryView() {
  const files = gitOk(['ls-files', '-z']).split('\0').filter(Boolean)
  const cache = new Map()
  return {
    files,
    read(file) {
      if (cache.has(file)) return cache.get(file)
      let value = null
      try {
        value = readFileSync(path.resolve(file), 'utf8')
      } catch {
        value = null
      }
      cache.set(file, value)
      return value
    },
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const context = {
    event: options.event,
    ref: options.ref,
    headRef: options['head-ref'] || undefined,
    baseRef: options['base-ref'] || undefined,
  }
  let plan
  try {
    const forced = forcedFullReason(context)
    if (forced) {
      plan = fullPlan(forced)
    } else {
      const entries = collectChanges(options, context.event)
      plan = safePlan({ entries, repo: repositoryView(), context })
    }
  } catch (error) {
    const reason = error instanceof UnsafeClassification ? error.reason : 'unexpected failure'
    plan = fullPlan(`fail-safe: ${reason}`)
  }

  const outputs = planToOutputs(plan)
  const explanation = renderExplanation(plan)
  process.stdout.write(explanation)
  if (options['json-out']) writeFileSync(options['json-out'], `${JSON.stringify(plan, null, 2)}\n`)
  if (options['github-output']) {
    appendFileSync(
      options['github-output'],
      `${Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    )
  }
  if (options['summary']) appendFileSync(options['summary'], explanation)
}

try {
  main()
} catch (error) {
  // Even argument or filesystem errors must yield a usable FULL result.
  const plan = fullPlan(`fail-safe: ${error instanceof Error ? error.message : 'unknown'}`)
  process.stdout.write(renderExplanation(plan))
  const target = process.env.GITHUB_OUTPUT
  if (target) {
    appendFileSync(
      target,
      `${Object.entries(planToOutputs(plan))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    )
  }
}
