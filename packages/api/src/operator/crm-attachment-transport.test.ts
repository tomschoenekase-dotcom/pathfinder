import { describe, expect, it } from 'vitest'

import { redactOperatorArgs } from './audit'
import { errorBody } from './http'

describe('CRM attachment transport boundaries', () => {
  it('keeps CSV contact content and signed file credentials out of audit arguments', () => {
    const redacted = redactOperatorArgs({
      operationId: 'example-operation',
      csvText: 'name,email\nExample Museum,contact@example.test',
      file: {
        download_url: 'https://files.example.test/data.csv?sig=private-signature',
        file_id: 'private-file-id',
        file_name: 'venues.csv',
        mime_type: 'text/csv',
      },
    })
    expect(redacted).toEqual({
      operationId: 'example-operation',
      csvText: '[text:46]',
      file: {
        download_url: '[redacted]',
        file_id: '[redacted]',
        file_name: 'venues.csv',
        mime_type: 'text/csv',
      },
    })
    expect(JSON.stringify(redacted)).not.toContain('contact@example.test')
    expect(JSON.stringify(redacted)).not.toContain('private-signature')
  })

  it('does not describe a failed mutating control as a safe repeatable read', () => {
    expect(errorBody('TOOL_FAILED', 'crm.stage_csv_import', 'request-1')).toMatchObject({
      retryable: false,
      outcome: 'unknown',
    })
    expect(errorBody('TOOL_FAILED', 'crm.get_import', 'request-2')).toMatchObject({
      retryable: true,
    })
  })
})
