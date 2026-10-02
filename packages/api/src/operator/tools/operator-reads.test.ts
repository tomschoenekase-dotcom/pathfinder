import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  OPERATOR_CONTROL_TOOL_NAMES,
  OPERATOR_MCP_OUTPUTS,
  OPERATOR_READ_TOOL_NAMES,
} from '@pathfinder/contracts/operator-mcp'

import {
  blockedAddressSet,
  evaluateCanContact,
  isUncontactedOrganization,
  operatorContactView,
  operatorUntrustedText,
  redactAddresses,
  type SnapshotContactInput,
} from '../crm-projection'
import { createOperatorRegistry, type OperatorCallContext } from '../registry'
import { OPERATOR_READ_TOOLS } from './index'
import { OPERATOR_MANUAL_TEXT } from './manual-text'

function contact(overrides: Partial<SnapshotContactInput> = {}): SnapshotContactInput {
  return {
    id: 'contact-1',
    venueId: null,
    fullName: 'Sample Person',
    title: 'Director',
    email: 'sample@example.com',
    phone: null,
    emailReadiness: 'VALID',
    permissionState: 'UNKNOWN',
    doNotContact: false,
    suppressionReason: null,
    suppressedAt: null,
    unsubscribedAt: null,
    complainedAt: null,
    lastHardBounceAt: null,
    ...overrides,
  }
}

const blockedStates: [string, Partial<SnapshotContactInput>, string][] = [
  ['doNotContact', { doNotContact: true }, 'do_not_contact'],
  ['suppressed', { suppressedAt: new Date() }, 'suppressed'],
  ['opted out', { permissionState: 'OPTED_OUT' }, 'suppressed'],
  ['hard bounced', { lastHardBounceAt: new Date() }, 'suppressed'],
  ['unsubscribed', { unsubscribedAt: new Date() }, 'unsubscribed'],
  ['complained', { complainedAt: new Date() }, 'complained'],
]

describe('operator CRM projection', () => {
  it('exposes an address only for a contactable person and always carries all four flags', () => {
    const ok = operatorContactView(contact())
    expect(ok.email).toBe('sample@example.com')
    expect(ok.contactable).toBe(true)
    for (const [, overrides] of blockedStates) {
      const view = operatorContactView(contact(overrides))
      expect(view.email).toBeNull()
      expect(view.contactable).toBe(false)
      expect(Object.keys(view.flags).sort()).toEqual([
        'complained',
        'doNotContact',
        'suppressed',
        'unsubscribed',
      ])
      expect(JSON.stringify(view)).not.toContain('example.com')
    }
  })

  it.each(blockedStates)('check_can_contact refuses a %s contact', (_name, overrides, reason) => {
    const answer = evaluateCanContact([
      { contact: contact(overrides), organizationId: 'org-1', organizationStage: null },
    ])
    expect(answer).toMatchObject({ allowed: false, reason, contactId: 'contact-1' })
  })

  it('one blocked row blocks the address; an organization in DO_NOT_CONTACT blocks it; unknown is refused', () => {
    expect(
      evaluateCanContact([
        { contact: contact(), organizationId: 'org-1', organizationStage: null },
        {
          contact: contact({ id: 'c2', doNotContact: true }),
          organizationId: 'org-2',
          organizationStage: null,
        },
      ]).allowed,
    ).toBe(false)
    expect(
      evaluateCanContact([
        { contact: contact(), organizationId: 'org-1', organizationStage: 'DO_NOT_CONTACT' },
      ]).reason,
    ).toBe('do_not_contact')
    expect(evaluateCanContact([])).toEqual({
      allowed: false,
      reason: 'unknown_address',
      organizationId: null,
      contactId: null,
    })
    expect(
      evaluateCanContact([
        { contact: contact(), organizationId: 'org-1', organizationStage: null },
      ]),
    ).toEqual({ allowed: true, reason: 'ok', organizationId: 'org-1', contactId: 'contact-1' })
  })

  it('marks notes untrusted, truncates at 500 and withholds suppressed addresses from text', () => {
    const long = operatorUntrustedText('x'.repeat(900))
    expect(long).toEqual({ untrusted: true, text: 'x'.repeat(500), truncated: true })
    expect(operatorUntrustedText('short')).toEqual({
      untrusted: true,
      text: 'short',
      truncated: false,
    })
    const blocked = blockedAddressSet([
      contact({ email: 'Gone@Example.com', doNotContact: true }),
      contact({ id: 'c2', email: 'bounced@example.com', lastHardBounceAt: new Date() }),
      contact({ id: 'c3', email: 'fine@example.com' }),
    ])
    expect([...blocked].sort()).toEqual(['bounced@example.com', 'gone@example.com'])
    // Free text never carries an address, blocked or not.
    expect(redactAddresses('write to gone@example.com or fine@example.com')).toBe(
      'write to [address withheld] or [address withheld]',
    )
    // A contactable row loses its address when the same address is blocked on another row.
    expect(
      operatorContactView(contact({ id: 'c4', email: 'Gone@example.com' }), blocked).email,
    ).toBeNull()
    expect(operatorContactView(contact({ fullName: 'Name <x@example.com>' })).displayName).toBe(
      'Name <[address withheld]>',
    )
  })

  it('applies the P17 uncontacted rule and counts a logged send', () => {
    const base = {
      stage: 'RESEARCHED',
      outreach: {
        everContacted: false,
        doNotContact: false,
        crmDrafts: 0,
        campaigns: [],
        duplicateReview: null,
      },
    }
    const asOrg = (value: unknown) => value as Parameters<typeof isUncontactedOrganization>[0]
    expect(isUncontactedOrganization(asOrg(base))).toBe(true)
    // A logged send (OUTREACH_SENT activity) sets everContacted in the shared projection.
    expect(
      isUncontactedOrganization(
        asOrg({ ...base, outreach: { ...base.outreach, everContacted: true } }),
      ),
    ).toBe(false)
    expect(isUncontactedOrganization(asOrg({ ...base, stage: 'PARKED' }))).toBe(false)
    expect(
      isUncontactedOrganization(asOrg({ ...base, outreach: { ...base.outreach, crmDrafts: 1 } })),
    ).toBe(false)
  })
})

describe('operator.get_manual', () => {
  it('equals docs/operator/manual.md and parses with the output contract', async () => {
    const docs = readFileSync(
      path.resolve(__dirname, '../../../../../docs/operator/manual.md'),
      'utf8',
    ).replaceAll('\r\n', '\n')
    expect(OPERATOR_MANUAL_TEXT).toBe(docs)
    const tool = OPERATOR_READ_TOOLS.find((entry) => entry.name === 'operator.get_manual')!
    const output = await tool.handler({}, {} as OperatorCallContext)
    expect(OPERATOR_MCP_OUTPUTS['operator.get_manual'].parse(output).text).toBe(docs)
    await expect(tool.handler({ extra: 1 }, {} as OperatorCallContext)).rejects.toThrow()
  })
})

describe('OPERATOR_READ_TOOLS', () => {
  it('covers exactly the P4 reads plus the discovery and operation reads, each with a read capability', () => {
    const names = OPERATOR_READ_TOOLS.map((tool) => tool.name).sort()
    expect(names).toEqual(
      [
        'crm.search_organizations',
        'crm.get_organization',
        'crm.list_candidates',
        'crm.get_contact_history',
        'crm.check_can_contact',
        'venues.list',
        'venues.list_operational_updates',
        'venues.get_visitor_summary',
        'venues.get_readiness',
        'venues.list_sessions',
        'venues.get_answer_evidence',
        'operator.get_attention',
        'support.list',
        'operator.get_manual',
        'customers.list',
        'crm.list_campaigns',
        'crm.list_campaign_members',
        'operator.get_operation',
        'operator.list_plans',
        'crm.resolve_account',
        'crm.get_account_context',
        'crm.list_contacts',
        'crm.list_notes',
        'crm.get_note',
        'crm.list_duplicates',
        'crm.list_imports',
        'crm.get_import',
        'crm.get_campaign',
        'crm.list_drafts',
        'crm.get_outreach_batch',
        'support.get_request',
        'customers.get_onboarding',
        'customers.list_blocking_questions',
        'customers.get_blocking_question',
        'support.list_messages',
        'crm.list_mailboxes',
        'crm.list_mail_threads',
        'crm.list_mail_messages',
        'crm.list_mail_receipts',
        'crm.list_mail_quarantine',
        'crm.list_mail_webhook_receipts',
        'crm.list_activity_receipts',
        'company.list_context',
        'reports.list',
        'reports.get_status',
        'reports.get',
        'reports.reconcile_generating',
        'billing.get_status',
        'billing.list_invoices',
        'routines.list',
        'routines.get_run_status',
        'access.list_memberships',
        'offboarding.list_plans',
        'offboarding.list_targets',
        'offboarding.list_evidence',
        'offboarding.list_artifacts',
        // Orchestration controls ride the same registry path; they need operator:plan, not a read.
        'operator.cancel_operation',
        'operator.recover_operation',
      ].sort(),
    )
    for (const tool of OPERATOR_READ_TOOLS) {
      const isControl = (OPERATOR_CONTROL_TOOL_NAMES as readonly string[]).includes(tool.name)
      if (isControl) {
        expect(tool.capability).toBe('operator:plan')
      } else {
        expect(OPERATOR_READ_TOOL_NAMES).toContain(tool.name)
        expect(tool.capability.endsWith(':read')).toBe(true)
      }
    }
  })
})

describe('separately registered onboarding proposal tools', () => {
  it('has a proposal binding beside the reads without treating it as a read', () => {
    const proposalTools = ['customers.propose_onboarding_questions']
    const registered = createOperatorRegistry().listTools()
    for (const name of proposalTools) {
      expect(registered.find((tool) => tool.name === name)?.effect).toBe('proposal')
      expect(OPERATOR_READ_TOOL_NAMES).not.toContain(name)
    }
  })
})
