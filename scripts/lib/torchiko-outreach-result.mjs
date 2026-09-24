import { createHash } from 'node:crypto'

const categories = ['SOURCE FACT', 'RELATIONSHIP FACT', 'TASK CONSTRAINT',
  'SALES HYPOTHESIS', 'APPROVED REUSABLE LANGUAGE', 'NONFACTUAL', 'UNSUPPORTED ADDITION']
export const textSha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
export class OutreachResultError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const requireValue = (condition, message) => {
  if (!condition) throw new OutreachResultError('INVALID_MODEL_OUTPUT', message)
}
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

/** The model writes every character and every claim classification. This only
 * concatenates those exact parts and computes Unicode code-point offsets. It
 * neither authors text, repairs claims, approves meaning nor changes a binding. */
export function compileNativeOutreachResult(task, candidate, identity) {
  requireValue(task?.schema === 'torchiko.native-writer-task/1' && task.SEND_AUTHORIZED === false,
    'One native no-send writer task is required.')
  requireValue(typeof task.taskId === 'string' && /^writer-task_[a-f0-9]{64}$/u.test(task.taskId),
    'Native task identity is invalid.')
  requireValue(typeof identity === 'string' && identity.trim() && identity.length <= 191,
    'Supply the actual invoking model/runtime identity, not a fabricated human actor.')
  requireValue(exactKeys(candidate, ['schema', 'subjectParts', 'bodyParts']) &&
    candidate.schema === 'torchiko.codex-outreach-text/1', 'Unexpected model result fields.')
  const annotations = []
  const compiled = {}
  for (const section of ['subject', 'body']) {
    const parts = candidate[section + 'Parts']
    requireValue(Array.isArray(parts) && parts.length > 0 && parts.length <= 40,
      'Each section needs one to forty original model-authored parts.')
    let position = 0
    compiled[section] = ''
    for (const part of parts) {
      requireValue(exactKeys(part, ['text', 'category', 'claimIds', 'reason', 'answers']),
        'Each part must contain only text, category, claimIds, reason and answers.')
      requireValue(typeof part.text === 'string' && part.text.length > 0 && part.text.length <= 12000 &&
        !/[\r\0]/u.test(part.text), 'Invalid original model-authored text.')
      requireValue(categories.includes(part.category), 'Unknown claim category.')
      requireValue(Array.isArray(part.claimIds) && part.claimIds.length <= 12 &&
        part.claimIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 191), 'Invalid claim IDs.')
      requireValue(typeof part.reason === 'string' && part.reason.length >= 12 && part.reason.length <= 2000,
        'A substantive model-authored claim explanation is required.')
      requireValue(Array.isArray(part.answers) && part.answers.length <= 5 &&
        part.answers.every(id => typeof id === 'string' && id.length > 0 && id.length <= 191), 'Invalid answer bindings.')
      requireValue(part.category !== 'APPROVED REUSABLE LANGUAGE',
        'This minimal compiler does not supply phrase approval provenance. Use native import with exact library evidence instead.')
      const end = position + Array.from(part.text).length
      compiled[section] += part.text
      if (/\S/u.test(part.text)) annotations.push({ annotation_id: `${section}-${position}-${end}`,
        section, start: position, end, quote: part.text, category: part.category,
        claim_ids: part.claimIds, reason: part.reason, answers: part.answers })
      position = end
    }
  }
  requireValue(compiled.subject.trim() && compiled.subject.length <= 160 && !/\n/u.test(compiled.subject),
    'Subject must be one bounded line.')
  requireValue(compiled.body.trim() && compiled.body.length <= 12000, 'Body is outside native bounds.')
  const result = { schema: 'torchiko.native-writer-result/1', taskId: task.taskId,
    binding: structuredClone(task.binding), generatedBy: { kind: 'model', identity },
    subject: compiled.subject, body: compiled.body, annotations, languageUses: [], assessment: null }
  requireValue(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 60000, 'Native result exceeds 60,000 bytes.')
  return result
}

const partSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string' }, category: { type: 'string', enum: categories.filter(c => c !== 'APPROVED REUSABLE LANGUAGE') },
    claimIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' },
    answers: { type: 'array', items: { type: 'string' } },
  }, required: ['text', 'category', 'claimIds', 'reason', 'answers'],
}
export const codexOutreachTextSchema = {
  type: 'object', additionalProperties: false,
  properties: { schema: { type: 'string', enum: ['torchiko.codex-outreach-text/1'] },
    subjectParts: { type: 'array', items: partSchema }, bodyParts: { type: 'array', items: partSchema } },
  required: ['schema', 'subjectParts', 'bodyParts'],
}
