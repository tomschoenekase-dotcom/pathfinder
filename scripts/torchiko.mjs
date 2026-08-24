#!/usr/bin/env node
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  buildBootstrapReport,
  buildConversationReplay,
  buildConversationAssessment,
  buildCompanyBrainStatus,
  buildDoctorReport,
  buildRepositoryMap,
  buildToolCoverageReport,
  findTests,
  listAgentTools,
  listFixtures,
  loadScenarioRegistry,
  loadCompanyBrainScenarioRegistry,
  simulateScenarioLocation,
  simulateScenarioTime,
  simulateScenarioVisitor,
} from './lib/torchiko-developer-tools.mjs'
import { executeSyntheticScenarioReset } from './lib/synthetic-scenario-worlds.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const json = args.includes('--json')
const positional = args.filter((arg) => arg !== '--json')

function usage() {
  return `Torchiko developer interface\n\nCommands:\n  dev bootstrap [--json]\n  doctor [--json]\n  repo map [--json]\n  tools list [--json]\n  tools coverage [--json]\n  fixtures list [--json]\n  scenarios validate [--json]\n  scenarios reset <scenario> --database <name> --confirm-database <name> [--json]\n  company-brain status [--json]\n  company-brain scenarios [--json]\n  simulate time <scenario> <iso-instant> [--json]\n  simulate location <scenario> <latitude> <longitude> [--json]\n  simulate visitor <scenario> <iso-instant> <bot|voice> [--json]\n  replay conversation <scenario> [--json]\n  replay assess <scenario> --stdin [--json]\n  tests find <query> [--json]\n  golden validate\n`
}

async function readBoundedStdin(limitBytes = 32 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > limitBytes) throw new Error('synthetic-response-too-large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function emit(value) {
  if (json || typeof value !== 'string') console.log(JSON.stringify(value, null, 2))
  else console.log(value)
}

async function main() {
  const [group, action, ...rest] = positional
  if (group === 'dev' && action === 'bootstrap') return emit(await buildBootstrapReport(root))
  if (group === 'doctor' && action === undefined) {
    const report = await buildDoctorReport(root)
    emit(report)
    if (!report.healthy) process.exitCode = 1
    return
  }
  if (group === 'repo' && action === 'map') return emit(await buildRepositoryMap(root))
  if (group === 'tools' && action === 'list') return emit(await listAgentTools(root))
  if (group === 'tools' && action === 'coverage') {
    const report = await buildToolCoverageReport(root)
    emit(report)
    if (!report.healthy) process.exitCode = 1
    return
  }
  if (group === 'fixtures' && action === 'list') return emit(await listFixtures(root))
  if (group === 'scenarios' && action === 'validate') {
    const report = await loadScenarioRegistry(root)
    emit(report)
    if (!report.healthy) process.exitCode = 1
    return
  }
  if (group === 'scenarios' && action === 'reset' && rest.length > 0) {
    try {
      return emit(await executeSyntheticScenarioReset({ root, args: rest }))
    } catch (error) {
      process.stderr.write(
        `Synthetic scenario reset refused: ${error instanceof Error ? error.message : 'scenario-reset-failed'}\n`,
      )
      process.exitCode = 1
      return
    }
  }
  if (group === 'company-brain' && action === 'status') {
    const report = await buildCompanyBrainStatus(root)
    emit(report)
    if (!report.healthy) process.exitCode = 1
    return
  }
  if (group === 'company-brain' && action === 'scenarios') {
    const report = await loadCompanyBrainScenarioRegistry(root)
    emit(report)
    if (!report.healthy) process.exitCode = 1
    return
  }
  if (group === 'simulate' && action === 'time' && rest.length === 2)
    return emit(await simulateScenarioTime(root, rest[0], rest[1]))
  if (group === 'simulate' && action === 'location' && rest.length === 3)
    return emit(await simulateScenarioLocation(root, rest[0], Number(rest[1]), Number(rest[2])))
  if (group === 'simulate' && action === 'visitor' && rest.length === 3)
    return emit(await simulateScenarioVisitor(root, rest[0], rest[1], rest[2]))
  if (group === 'replay' && action === 'conversation' && rest.length === 1)
    return emit(await buildConversationReplay(root, rest[0]))
  if (group === 'replay' && action === 'assess' && rest.length === 2 && rest[1] === '--stdin') {
    try {
      const report = await buildConversationAssessment(root, rest[0], await readBoundedStdin())
      emit(report)
      if (report.verdict !== 'pass') process.exitCode = 1
      return
    } catch (error) {
      process.stderr.write(
        `Synthetic replay assessment refused: ${error instanceof Error ? error.message : 'assessment-failed'}\n`,
      )
      process.exitCode = 1
      return
    }
  }
  if (group === 'tests' && action === 'find' && rest.length > 0)
    return emit(await findTests(root, rest.join(' ')))
  if (group === 'golden' && action === 'validate') {
    const child = spawn(process.execPath, [path.join(root, 'scripts/golden-venue/validate.mjs')], {
      cwd: root,
      shell: false,
      stdio: 'inherit',
    })
    child.once('error', () => {
      process.exitCode = 1
    })
    child.once('exit', (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1)
    })
    return
  }
  process.stderr.write(usage())
  process.exitCode = 2
}

await main()
