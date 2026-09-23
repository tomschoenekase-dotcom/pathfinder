import { beforeEach, describe, expect, it, vi } from 'vitest'

const { record, LearningError } = vi.hoisted(() => ({
  record: vi.fn(),
  LearningError: class extends Error {
    code = 'FORBIDDEN'
  },
}))
vi.mock('@pathfinder/db', () => ({
  recordConversationLearningCandidate: record,
  ConversationLearningActionError: LearningError,
}))
import { captureConversationLearning } from './capture-conversation-learning'

const turn = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  sessionId: 'session-a',
  guestChatTurnId: 'turn-a',
  userMessageId: 'message-a',
  sourceScope: 'PUBLIC' as const,
  message: 'The Case 12 exhibit is on the second floor.',
}
describe('bounded learning capture', () => {
  beforeEach(() => vi.clearAllMocks())
  it('passes evidence references without retaining the message text', async () => {
    await captureConversationLearning(turn)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: turn.tenantId,
        venueId: turn.venueId,
        userMessageId: turn.userMessageId,
        classifier: { kind: 'LOCATION', version: 'conversation-learning-en-v1' },
      }),
    )
    expect(JSON.stringify(record.mock.calls)).not.toContain(turn.message)
  })
  it('retains established employee provenance for the durable eligibility check', async () => {
    await captureConversationLearning({
      ...turn,
      sourceScope: 'SECOND_LAYER',
      actor: { id: 'employee', role: 'STAFF' },
    })
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'SECOND_LAYER',
        authenticatedActorRef: 'employee',
      }),
    )
  })
  it.each([
    'Where is Case 12?',
    'The display is ugly.',
    'This exhibit is boring and terrible.',
    'The guide is stupid.',
    'We have 20 minutes and our children like trains. What should we see?',
    'We need a quieter place and step-free access. What is known here?',
    'Our children are five and seven.',
    'We are on the second floor.',
  ])('does not write a factual candidate for non-venue context: %s', async (message) => {
    await captureConversationLearning({ ...turn, message })
    expect(record).not.toHaveBeenCalled()
  })
  it('treats disabled capture as an expected skip while surfacing infrastructure failure', async () => {
    record.mockRejectedValueOnce(new LearningError('disabled'))
    await expect(captureConversationLearning(turn)).resolves.toBeUndefined()
    record.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(captureConversationLearning(turn)).rejects.toThrow('database unavailable')
  })
})
