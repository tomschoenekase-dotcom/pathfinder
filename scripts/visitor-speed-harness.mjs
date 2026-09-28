#!/usr/bin/env node

/**
 * Browser-truth timing for the public venue guide's NDJSON chat stream.
 *
 * Question input is JSON: an array of strings (one fresh browser session per
 * question), or an array of { venue?, questions: string[] } scenarios. A
 * scenario starts in a fresh context and subsequent questions are follow-ups.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--headed') options.headed = true
    else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[key] = value
      index += 1
    } else throw new Error(`Unexpected argument: ${arg}`)
  }
  return options
}

function printHelp() {
  console.log(`Usage: node scripts/visitor-speed-harness.mjs --url GUIDE_URL --questions questions.json [options]

Options:
  --out-dir PATH       Output folder (default: sibling task qa/visitor-speed)
  --timeout-ms N       Per turn timeout (default: 60000)
  --headed             Show Chromium
  --project-root PATH  Resolve Playwright from this repository (default: script parent)

Question JSON may be ["Question one", "Question two"] or
[{"venue":"Space Museum","questions":["First message", "Follow-up"]}].
Each string in the first form is a new browser session; each scenario also
starts in a new session and uses its later questions as follow-ups.

The harness opens only the supplied guide URL. Point it at local development
for provider-stub runs. It never sends a turn unless this command is run.`)
}

function getPlaywright(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'node_modules', 'playwright'),
    path.join(projectRoot, 'node_modules', '@playwright', 'test'),
    'playwright',
    '@playwright/test',
  ]
  const pnpmStore = path.join(projectRoot, 'node_modules', '.pnpm')
  if (existsSync(pnpmStore)) {
    for (const packageDir of readdirSync(pnpmStore)) {
      if (packageDir.startsWith('playwright@'))
        candidates.push(path.join(pnpmStore, packageDir, 'node_modules', 'playwright'))
      if (packageDir.startsWith('@playwright+test@'))
        candidates.push(path.join(pnpmStore, packageDir, 'node_modules', '@playwright', 'test'))
    }
  }
  for (const candidate of candidates) {
    try {
      const candidateRequire = path.isAbsolute(candidate)
        ? createRequire(path.join(candidate, 'package.json'))
        : require
      const resolved = candidateRequire.resolve(candidate)
      const loaded = candidateRequire(resolved)
      if (loaded.chromium) return loaded
      if (loaded.default?.chromium) return loaded.default
    } catch {}
  }
  throw new Error(
    `Playwright is unavailable. Install the repository's existing browser dependencies first; tried ${candidates.join(', ')}.`,
  )
}

const instrumentation = String.raw`(() => {
  const state = window.__visitorSpeed = { streams: [], clickAt: null, workingAt: null, workingIndicatorsBefore: 0, firstTextAt: null, paints: [], latestText: '', assistantMessagesBefore: 0, observer: null, frame: 0 };
  const originalFetch = window.fetch.bind(window);
  const decoder = new TextDecoder();
  function recordLine(stream, line, now) {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'delta' && typeof event.delta === 'string' && event.delta.length) {
      stream.deltaCount += 1;
      if (stream.firstDeltaAt === null) stream.firstDeltaAt = now;
      stream.lastDeltaAt = now;
    }
    if (event.type === 'complete') { stream.completedAt = now; stream.completeEvent = true; }
    if (event.type === 'error') { stream.errorAt = now; stream.errorEvent = { code: event.code, publicCode: event.publicCode }; }
  }
  window.fetch = async (...args) => {
    const fetchStartedAt = performance.now();
    const response = await originalFetch(...args);
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (!requestUrl.includes('/api/chat-stream') || !response.body) return response;
    const stream = { requestAt: fetchStartedAt, headersAt: performance.now(), headers: {}, deltaCount: 0, firstDeltaAt: null, lastDeltaAt: null, completedAt: null, completeEvent: false, errorEvent: null };
    for (const name of ['content-encoding', 'cache-control', 'x-accel-buffering', 'transfer-encoding', 'content-type', 'content-length']) stream.headers[name] = response.headers.get(name);
    state.streams.push(stream);
    let buffer = '';
    const tapped = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        const now = performance.now();
        for (const line of lines) recordLine(stream, line, now);
        controller.enqueue(chunk);
      },
      flush() {
        buffer += decoder.decode();
        recordLine(stream, buffer, performance.now());
      }
    }));
    Object.defineProperty(response, 'body', { configurable: true, get: () => tapped });
    return response;
  };
  function samplePaint() {
    state.frame = 0;
    const indicators = document.querySelectorAll('[role="log"] > div[aria-hidden="true"]');
    if (state.workingAt === null && indicators.length > state.workingIndicatorsBefore && indicators[indicators.length - 1].getClientRects().length) {
      state.workingAt = performance.now();
    }
    const articles = document.querySelectorAll('[role="log"] article[data-role="assistant"]');
    if (articles.length <= state.assistantMessagesBefore) return;
    const article = articles[articles.length - 1];
    const text = article?.innerText?.trim() || '';
    if (text && text !== state.latestText && article.getClientRects().length) {
      const now = performance.now();
      state.latestText = text;
      state.paints.push({ at: now, chars: text.length });
      if (state.firstTextAt === null) state.firstTextAt = now;
    }
  }
  state.observer = new MutationObserver(() => { if (!state.frame) state.frame = requestAnimationFrame(samplePaint); });
  state.observer.observe(document, { subtree: true, childList: true, characterData: true });
  window.__visitorSpeedBegin = () => {
    state.clickAt = null; state.workingAt = null; state.firstTextAt = null; state.paints = []; state.latestText = ''; state.streams = [];
    state.assistantMessagesBefore = document.querySelectorAll('[role="log"] article[data-role="assistant"]').length;
    state.workingIndicatorsBefore = document.querySelectorAll('[role="log"] > div[aria-hidden="true"]').length;
    document.addEventListener('click', () => { state.clickAt = performance.now(); }, { capture: true, once: true });
  };
})();`

function summarizeMarkdown(result) {
  const lines = [
    '# Visitor first words browser timing',
    '',
    `Guide URL: ${result.guideUrl}`,
    `Run: ${result.startedAt}`,
    '',
    '| # | Venue | Kind | Click → working (ms) | Click → words (ms) | Click → complete (ms) | Headers (ms) | First delta (ms) | Deltas | Paint steps | Buffering flag | Status |',
    '|--:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
  ]
  for (const turn of result.turns) {
    const ms = (value) => (value == null ? '—' : Math.round(value).toString())
    lines.push(
      `| ${turn.index} | ${escapeCell(turn.venue || '—')} | ${turn.kind} | ${ms(turn.clickToWorkingMs)} | ${ms(turn.clickToFirstTextMs)} | ${ms(turn.clickToCompleteMs)} | ${ms(turn.clickToHeadersMs)} | ${ms(turn.clickToFirstDeltaMs)} | ${turn.deltaCount ?? '—'} | ${turn.visiblePaintSteps ?? '—'} | ${turn.bufferingFlag == null ? '—' : turn.bufferingFlag ? 'yes' : 'no'} | ${turn.status} |`,
    )
  }
  const successful = result.turns.filter(
    (turn) => turn.status === 'complete' && turn.clickToFirstTextMs != null,
  )
  if (successful.length) {
    const sorted = successful.map((turn) => turn.clickToFirstTextMs).sort((a, b) => a - b)
    lines.push(
      '',
      `First visible words median: ${Math.round(percentile(sorted, 0.5))} ms; p90: ${Math.round(percentile(sorted, 0.9))} ms (${successful.length} turns).`,
    )
  }
  lines.push(
    '',
    'The buffering flag is true when at least two nonempty deltas arrive within 100 ms from first to last; one-delta replies are indeterminate. Working-state time is the first visible new-turn indicator. All measurements are browser-side elapsed milliseconds.',
  )
  return `${lines.join('\n')}\n`
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}
function percentile(sorted, p) {
  if (p === 0.5 && sorted.length % 2 === 0) {
    const middle = sorted.length / 2
    return (sorted[middle - 1] + sorted[middle]) / 2
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

async function loadScenarios(file) {
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error('Question file must contain a nonempty JSON array.')
  return parsed.map((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) return { venue: null, questions: [entry] }
    if (
      entry &&
      typeof entry === 'object' &&
      Array.isArray(entry.questions) &&
      entry.questions.length &&
      entry.questions.every((q) => typeof q === 'string' && q.trim())
    ) {
      return {
        venue: typeof entry.venue === 'string' ? entry.venue : null,
        questions: entry.questions,
      }
    }
    throw new Error(
      `Question entry ${index + 1} must be a nonempty string or an object with a nonempty questions array.`,
    )
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()
  if (!options.url || !options.questions)
    throw new Error('Both --url and --questions are required. Use --help for details.')
  const guideUrl = new URL(options.url)
  if (!['http:', 'https:'].includes(guideUrl.protocol))
    throw new Error('--url must use http or https.')
  const timeoutMs = Number(options['timeout-ms'] || 60000)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000)
    throw new Error('--timeout-ms must be at least 1000.')
  const scenarios = await loadScenarios(path.resolve(options.questions))
  const projectRoot = path.resolve(options['project-root'] || repoRoot)
  const { chromium } = getPlaywright(projectRoot)
  const browser = await chromium.launch({ headless: !options.headed })
  const results = []
  const startedAt = new Date().toISOString()

  try {
    for (const scenario of scenarios) {
      const context = await browser.newContext()
      await context.addInitScript(instrumentation)
      const page = await context.newPage()
      await page.goto(guideUrl.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      const composer = page.locator('textarea').first()
      await composer.waitFor({ state: 'visible', timeout: timeoutMs })
      for (let questionIndex = 0; questionIndex < scenario.questions.length; questionIndex += 1) {
        const question = scenario.questions[questionIndex]
        const log = page.locator('[role="log"]')
        await composer.fill(question)
        await page.evaluate(() => window.__visitorSpeedBegin())
        await page.getByRole('button', { name: 'Send message' }).click()
        const clickEpoch = await page.evaluate(() => window.__visitorSpeed.clickAt)
        let status = 'timeout'
        try {
          await page.waitForFunction(
            () => {
              const s = window.__visitorSpeed?.streams?.at(-1)
              return Boolean(s?.completeEvent || s?.errorEvent)
            },
            null,
            { timeout: timeoutMs },
          )
          status = await page.evaluate(() =>
            window.__visitorSpeed.streams.at(-1)?.errorEvent ? 'error' : 'complete',
          )
        } catch {}
        await page.waitForTimeout(50)
        const sample = await page.evaluate(
          ({ clickEpoch }) => {
            const state = window.__visitorSpeed
            const stream = state.streams.at(-1)
            const clickTo = (at) => (at == null ? null : at - clickEpoch)
            const currentCount = document.querySelectorAll(
              '[role="log"] article[data-role="assistant"]',
            ).length
            return {
              clickToWorkingMs: clickTo(state.workingAt),
              workingWithin300Ms:
                state.workingAt == null ? null : state.workingAt - clickEpoch <= 300,
              clickToFirstTextMs: clickTo(state.firstTextAt),
              clickToCompleteMs: clickTo(stream?.completedAt),
              clickToHeadersMs: clickTo(stream?.headersAt),
              requestToHeadersMs:
                stream?.headersAt == null ? null : stream.headersAt - stream.requestAt,
              clickToFirstDeltaMs: clickTo(stream?.firstDeltaAt),
              firstDeltaToLastDeltaMs:
                stream?.firstDeltaAt == null || stream?.lastDeltaAt == null
                  ? null
                  : stream.lastDeltaAt - stream.firstDeltaAt,
              deltaCount: stream?.deltaCount ?? 0,
              visiblePaintSteps: state.paints.length,
              visiblePaintTimelineMs: state.paints.map((paint) => paint.at - clickEpoch),
              assistantMessagesBefore: state.assistantMessagesBefore,
              assistantMessagesAfter: currentCount,
              responseHeaders: stream?.headers ?? null,
              bufferingFlag:
                stream?.deltaCount < 2 ||
                stream?.firstDeltaAt == null ||
                stream?.lastDeltaAt == null
                  ? null
                  : stream.lastDeltaAt - stream.firstDeltaAt <= 100,
              streamError: stream?.errorEvent ?? null,
            }
          },
          { clickEpoch },
        )
        results.push({
          index: results.length + 1,
          venue: scenario.venue,
          kind: questionIndex === 0 ? 'first' : 'follow-up',
          question,
          status,
          ...sample,
        })
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }

  const output = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    guideUrl: guideUrl.href,
    questionFile: path.resolve(options.questions),
    turnCount: results.length,
    turns: results,
  }
  const outDir = path.resolve(
    options['out-dir'] || path.join(projectRoot, '..', 'qa', 'visitor-speed'),
  )
  await mkdir(outDir, { recursive: true })
  const stem = `visitor-speed-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}`
  const jsonPath = path.join(outDir, `${stem}.json`)
  const markdownPath = path.join(outDir, `${stem}.md`)
  await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  await writeFile(markdownPath, summarizeMarkdown(output), 'utf8')
  console.log(`JSON: ${jsonPath}`)
  console.log(`Markdown: ${markdownPath}`)
  console.log(
    `Turns: ${results.length}; complete: ${results.filter((turn) => turn.status === 'complete').length}; error/timeout: ${results.filter((turn) => turn.status !== 'complete').length}`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
