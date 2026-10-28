import { spawn } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateAnswerQuestions,
  buildAnswerScenarios,
  gradeVenueAnswer,
  normalizeAnswerFact,
  precheckAnswerFacts,
} from './guest-query-evaluation-contract.mjs'
import { runVisitorScenarios, getPlaywright } from './visitor-speed-harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(
  await readFile(new URL('./fixtures/venue-answer-questions.json', import.meta.url), 'utf8'),
)
const copy = () => structuredClone(fixture)
const grade = (question, answer, status = 'complete') =>
  gradeVenueAnswer(question, { answer, status })

test('fictional fixture validates 26 questions covering every required visitor kind', () => {
  assert.equal(fixture.length, 26)
  assert.deepEqual(validateAnswerQuestions(fixture), fixture)
  assert.equal(new Set(fixture.map((q) => q.kind)).size, 9)
})

test('validator rejects short sets, duplicate IDs, missing coverage and blank fields', () => {
  assert.throws(() => validateAnswerQuestions(fixture.slice(0, 24)))
  for (const mutate of [
    (q) => {
      q[1].id = q[0].id
    },
    (q) => {
      q.forEach((row) => {
        if (row.kind === 'price') row.kind = 'other'
      })
    },
    (q) => {
      q[0].question = ' '
    },
    (q) => {
      q[0].expect[0].fact = ''
    },
    (q) => {
      q[0].expect[0].ledgerQuote = ''
    },
    (q) => {
      q[0].expect[0].sourceUrl = 'not a URL'
    },
    (q) => {
      q[0].kind = 'invented'
    },
    (q) => {
      q[0].id = '../unsafe'
    },
    (q) => {
      q[0].expect[0].sourceUrl = 'https://user:password@quillbrook.example/'
    },
    (q) => {
      q[0].mustNotSay = ['']
    },
  ]) {
    const questions = copy()
    mutate(questions)
    assert.throws(() => validateAnswerQuestions(questions))
  }
})

test('validator requires a real dated timestamp with an explicit offset and a valid timezone', () => {
  for (const stamp of [
    '2026-10-28',
    '2026-10-28T12:00:00',
    '2026-02-30T12:00:00-06:00',
    'nonsense',
  ]) {
    const questions = copy()
    questions[0].askedAt = stamp
    assert.throws(() => validateAnswerQuestions(questions), stamp)
  }
  const questions = copy()
  questions[0].timeZone = 'America/Nowhere'
  assert.throws(() => validateAnswerQuestions(questions))
})

test('follow-up references must exist, point backward, and cannot self-reference', () => {
  for (const reference of ['missing', 'follow-clock', 'follow-clock-near']) {
    const questions = copy()
    questions.find((q) => q.id === 'follow-clock').followUpOf = reference
    assert.throws(() => validateAnswerQuestions(questions), reference)
  }
  const questions = copy()
  delete questions.find((q) => q.id === 'follow-clock').followUpOf
  assert.throws(() => validateAnswerQuestions(questions))
})

test('scenario grouping follows ancestor chains and leaves independent questions fresh', () => {
  const scenarios = buildAnswerScenarios(fixture)
  assert.equal(scenarios.length, 23)
  assert.deepEqual(
    scenarios.find((s) => s.questions[0].id === 'thing-clock').questions.map((q) => q.id),
    ['thing-clock', 'follow-clock', 'follow-clock-near'],
  )
  assert.deepEqual(
    scenarios.find((s) => s.questions[0].id === 'food-cafe').questions.map((q) => q.id),
    ['food-cafe', 'follow-cafe'],
  )
  assert.equal(scenarios.flatMap((s) => s.questions).length, fixture.length)
})

test('normalization permits whitespace/case differences without erasing numeric distinctions', () => {
  assert.equal(normalizeAnswerFact('  EAST\n Gallery  '), normalizeAnswerFact('east gallery'))
  assert.notEqual(normalizeAnswerFact('$18'), normalizeAnswerFact('$180'))
})

test('source precheck reports absent facts before browser turns', () => {
  const ledger = fixture.flatMap((q) => q.expect.map((e) => e.ledgerQuote)).join('\n')
  assert.equal(precheckAnswerFacts(fixture, ledger).status, 'pass')
  const result = precheckAnswerFacts(fixture, '')
  assert.equal(result.status, 'fail')
  assert.ok(
    result.missing.some(
      (row) => row.id === 'price-adult' && row.fact === 'Adult admission costs $18.',
    ),
  )
})

test('only evidence-covered complete answers pass; omitted required facts fail', () => {
  const question = fixture.find((q) => q.id === 'price-adult')
  assert.equal(grade(question, 'Adult admission costs $18.').status, 'pass')
  assert.equal(grade(question, 'Admission is affordable.').status, 'fail')
  assert.notEqual(grade(question, 'Adult admission costs $18.', 'timeout').status, 'pass')
  assert.notEqual(grade(question, 'Adult admission costs $18.', 'error').status, 'pass')
})

test('negation, longer numbers, contradictions and additional unsupported claims cannot false-pass', () => {
  const question = fixture.find((q) => q.id === 'price-adult')
  for (const answer of [
    'Adult admission costs $180.',
    'It is false that Adult admission costs $18.',
    'Adult admission costs $18. Actually admission is $30.',
    'Adult admission costs $18. All children are guaranteed free entry.',
  ])
    assert.notEqual(grade(question, answer).status, 'pass', answer)
})

test('list completeness and actual venue-local date drift require review', () => {
  const list = fixture.find((q) => q.id === 'list-galleries')
  assert.equal(grade(list, list.expect.map((e) => e.fact).join(', ')).status, 'needs-human')
  const question = fixture[0]
  assert.equal(
    gradeVenueAnswer(question, {
      answer: question.expect[0].fact,
      status: 'complete',
      actualAskedAt: '2026-10-29T12:00:00-05:00',
    }).status,
    'needs-human',
  )
  assert.equal(
    gradeVenueAnswer(question, {
      answer: question.expect[0].fact,
      status: 'complete',
      actualAskedAt: '2026-10-28T18:00:00Z',
    }).status,
    'pass',
  )
})

test('mustNotSay fails even when the required fact is also present', () => {
  const question = fixture.find((q) => q.id === 'unknown-allergy')
  assert.equal(
    grade(
      question,
      'I cannot confirm sesame allergen information. Ask staff. It is guaranteed sesame-free.',
    ).status,
    'fail',
  )
})

test('unknown and not-offered answers stay subject to human review', () => {
  for (const id of ['unknown-lockers', 'absent-hotel']) {
    const question = fixture.find((q) => q.id === id)
    assert.equal(grade(question, question.expect[0].fact).status, 'needs-human')
  }
})

const stubHtml = `<!doctype html><html><body><div role="log"></div><textarea aria-label="Message"></textarea><button aria-label="Send message">Send message</button><script>
let history=[];
document.querySelector('button').onclick=async()=>{
 const text=document.querySelector('textarea').value;
 const previous=localStorage.getItem('turns')||'0';
 const res=await fetch('/api/chat-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,history,previous})});
 const article=document.createElement('article'); article.dataset.role='assistant';document.querySelector('[role="log"]').append(article);
 const reader=res.body.getReader();let pending='';const decoder=new TextDecoder();
 while(true){const part=await reader.read();if(part.done)break;pending+=decoder.decode(part.value,{stream:true});const lines=pending.split('\\n');pending=lines.pop();for(const line of lines){if(!line)continue;const event=JSON.parse(line);if(event.type==='delta')article.textContent+=event.delta;}}
 history.push(text);localStorage.setItem('turns',String(Number(previous)+1));
};</script></body></html>`

test(
  'loopback browser captures visible answers and screenshots with isolated scenarios and retained follow-ups',
  { timeout: 60000 },
  async () => {
    const requests = []
    const server = createServer(async (req, res) => {
      if (req.url === '/api/chat-stream') {
        let body = ''
        for await (const chunk of req) body += chunk
        const payload = JSON.parse(body)
        requests.push(payload)
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' })
        res.write(
          JSON.stringify({ type: 'delta', delta: `Visible answer ${requests.length}` }) + '\n',
        )
        setTimeout(() => res.end(JSON.stringify({ type: 'complete' }) + '\n'), 60)
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(stubHtml)
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const projectRoot = process.env.TORCHIKO_BROWSER_PROJECT_ROOT || root
      const { chromium } = getPlaywright(projectRoot)
      const artifactRoot = resolve(root, '..', 'qa', 'answer-test')
      await mkdir(artifactRoot, { recursive: true })
      const outDir = await mkdtemp(join(artifactRoot, 'browser-'))
      const selected = ['thing-clock', 'follow-clock', 'hours-today'].map((id) =>
        fixture.find((q) => q.id === id),
      )
      const scenarios = [
        { venue: null, questions: selected.slice(0, 2) },
        { venue: null, questions: selected.slice(2) },
      ]
      const result = await runVisitorScenarios({
        guideUrl: `http://127.0.0.1:${server.address().port}/`,
        scenarios,
        outDir,
        viewport: 'mobile',
        projectRoot,
        timeoutMs: 5000,
        chromium,
      })
      const turns = Array.isArray(result) ? result : result.turns
      assert.equal(turns.length, 3)
      assert.deepEqual(
        requests.map((r) => r.history.length),
        [0, 1, 0],
      )
      assert.deepEqual(
        requests.map((r) => r.previous),
        ['0', '1', '0'],
      )
      for (const [index, turn] of turns.entries()) {
        assert.equal(turn.questionId, selected[index].id)
        assert.equal(turn.status, 'complete')
        assert.equal(turn.answer, `Visible answer ${index + 1}`)
        assert.ok((await stat(turn.screenshot)).size > 100)
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  },
)

async function cliWorkspace() {
  const parent = resolve(root, '..', 'qa', 'answer-test')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'cli-'))
}
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/venue-answer-test.mjs'), ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}
const questionFile = join(root, 'scripts/fixtures/venue-answer-questions.json')
function offlinePackage(includeFacts) {
  return {
    schemaVersion: 3,
    places: { create: [], update: [], delete: [] },
    knowledgeEntries: {
      create: [
        {
          itemKey: '00000000-0000-4000-8000-000000000001',
          provenance: { sourceType: 'MANUAL', contentOrigin: 'AI_GENERATED' },
          value: {
            title: 'Fictional Quillbrook visitor facts',
            category: 'GENERAL',
            isEnabled: true,
            content: includeFacts
              ? fixture.flatMap((q) => q.expect.map((e) => e.fact)).join('\n')
              : 'Quillbrook is fictional.',
          },
        },
      ],
      update: [],
      delete: [],
    },
  }
}

test(
  'CLI offline-only uses production preview and precheck failure prevents any HTTP request',
  { timeout: 60000 },
  async () => {
    const dir = await cliWorkspace()
    const packagePath = join(dir, 'package.json')
    await writeFile(packagePath, JSON.stringify(offlinePackage(true)))
    const passed = await runCli([
      '--questions',
      questionFile,
      '--offline',
      packagePath,
      '--out',
      join(dir, 'pass'),
    ])
    assert.equal(passed.code, 0, passed.output)
    const proof = JSON.parse(await readFile(join(dir, 'pass/results.json'), 'utf8'))
    assert.equal(proof.status, 'offline-only')
    assert.equal(proof.precheck.status, 'pass')
    assert.equal(proof.answers.length, 0)
    assert.match(await readFile(join(dir, 'pass/REVIEW.md'), 'utf8'), /offline/i)
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      res.end(stubHtml)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      await writeFile(packagePath, JSON.stringify(offlinePackage(false)))
      const failed = await runCli([
        '--questions',
        questionFile,
        '--offline',
        packagePath,
        '--url',
        `http://127.0.0.1:${server.address().port}/`,
        '--out',
        join(dir, 'fail'),
      ])
      assert.equal(failed.code, 1, failed.output)
      const result = JSON.parse(await readFile(join(dir, 'fail/results.json'), 'utf8'))
      assert.equal(result.status, 'precheck-failed')
      assert.equal(result.precheck.status, 'fail')
      assert.equal(requests, 0)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  },
)

for (const interruptAfterFirst of [false, true]) {
  test(
    `CLI loopback ${interruptAfterFirst ? 'retains completed-turn evidence after navigation error' : 'writes all answers, grades, screenshots and REVIEW'}`,
    { timeout: 60000 },
    async () => {
      const dir = await cliWorkspace()
      let count = 0
      const server = createServer(async (req, res) => {
        if (req.url === '/api/chat-stream') {
          let body = ''
          for await (const chunk of req) body += chunk
          const question = fixture.find((q) => q.question === JSON.parse(body).text)
          count++
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
          res.end(
            JSON.stringify({ type: 'delta', delta: question.expect.map((e) => e.fact).join(' ') }) +
              '\n' +
              JSON.stringify({ type: 'complete' }) +
              '\n',
          )
        } else if (interruptAfterFirst && count > 0 && req.url === '/') {
          req.socket.destroy()
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(stubHtml)
        }
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const output = join(dir, 'run')
        const execution = await runCli([
          '--questions',
          questionFile,
          '--url',
          `http://127.0.0.1:${server.address().port}/`,
          '--out',
          output,
          '--viewport',
          'desktop',
        ])
        assert.equal(execution.code, 1, execution.output)
        const results = JSON.parse(await readFile(join(output, 'results.json'), 'utf8'))
        assert.equal(results.status, interruptAfterFirst ? 'error' : 'needs-human')
        assert.equal(results.answers.length, interruptAfterFirst ? 1 : fixture.length)
        assert.ok(results.finishedAt)
        const review = await readFile(join(output, 'REVIEW.md'), 'utf8')
        assert.match(review, /hours-today/)
        for (const answer of results.answers) {
          assert.equal(answer.status, 'complete')
          assert.ok(answer.answer.length)
          assert.ok((await stat(answer.screenshot)).size > 100)
        }
        if (interruptAfterFirst) assert.ok(results.error)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    },
  )
}

test('signed numbers and question punctuation cannot create false passes', () => {
  const question = structuredClone(fixture.find((q) => q.id === 'price-adult'))
  question.expect[0].fact = '$12'
  assert.equal(grade(question, '$12').status, 'pass')
  assert.equal(grade(question, '-$12').status, 'fail')
  assert.equal(grade(question, '+$12').status, 'fail')
  assert.equal(grade(question, '$12?').status, 'needs-human')
  assert.equal(precheckAnswerFacts([question], '-$12').status, 'fail')
})

test('sibling follow-ups cannot silently become a single sequential conversation', () => {
  const questions = copy()
  questions.find((q) => q.id === 'follow-clock-near').followUpOf = 'thing-clock'
  assert.throws(() => validateAnswerQuestions(questions))
  assert.throws(() => buildAnswerScenarios(questions))
})

test('rendered-answer mismatch, empty UI or unchanged assistant count cannot pass', () => {
  const question = fixture.find((q) => q.id === 'price-adult')
  const base = {
    answer: question.expect[0].fact,
    status: 'complete',
    renderedAnswer: question.expect[0].fact,
    assistantMessagesBefore: 0,
    assistantMessagesAfter: 1,
  }
  assert.equal(gradeVenueAnswer(question, base).status, 'pass')
  for (const change of [
    { renderedAnswer: '' },
    { answerVisible: false },
    { renderedAnswer: 'The visitor saw an unrelated answer.' },
    { assistantMessagesAfter: 0 },
    { assistantMessagesBefore: 1, assistantMessagesAfter: 1 },
  ])
    assert.equal(gradeVenueAnswer(question, { ...base, ...change }).status, 'needs-human')
})

test('precheck decodes only the production renderer escape set', () => {
  const question = structuredClone(fixture.find((q) => q.id === 'food-cafe'))
  for (const [fact, rendered] of [
    ['Cup & Cone', 'Cup \\u0026 Cone'],
    ['Entry < Exit >', 'Entry \\u003c Exit \\u003e'],
    ['First Second Third', 'First\\u2028Second\\u2029Third'],
  ]) {
    question.expect[0].fact = fact
    assert.equal(precheckAnswerFacts([question], rendered).status, 'pass', rendered)
  }
  question.expect[0].fact = 'A Gallery'
  assert.equal(precheckAnswerFacts([question], '\\u0041 Gallery').status, 'fail')
})
