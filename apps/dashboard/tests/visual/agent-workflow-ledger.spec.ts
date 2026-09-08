import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

const transitionHeads = {
  heads: [
    {
      registryKey: 'visitor-arrival',
      revision: 7,
      selectedRunCount: 42,
      activeVersion: {
        id: '11111111-1111-4111-8111-111111111111',
        version: 3,
        contentHash: 'sha256:fixture-active-version',
        requiredToolCapabilities: ['venue.read', 'visitor.chat.respond'],
      },
      activationEvent: {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'ROLLBACK',
        eventHash: 'sha256:synthetic-rollback-fixture',
        reason: 'Synthetic fixture rollback history; this is not a live transition.',
        createdBy: 'fixture-operator',
        createdAt: '2026-09-07T12:00:00.000Z',
        approvalDecisionId: null,
        promotionAssessmentId: null,
      },
    },
  ],
  events: [],
  nextHeadAfterRegistryKey: null,
  nextEventBefore: null,
}

const transitionComposer = {
  head: {
    registryKey: 'visitor-arrival',
    expectedHeadRevision: 7,
    selectedRunCount: 42,
    activeVersion: {
      id: '11111111-1111-4111-8111-111111111111',
      version: 3,
      contentHash: 'sha256:fixture-active-version',
      requiredToolCapabilities: ['venue.read', 'visitor.chat.respond'],
    },
    activationEvent: {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'ROLLBACK',
      eventHash: 'sha256:synthetic-rollback-fixture',
      resultingRevision: 7,
      createdAt: '2026-09-07T12:00:00.000Z',
    },
    revokeEligible: true,
    availablePriorBaseline: {
      workflowVersionId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'sha256:fixture-active-version',
    },
  },
  rollbackTargets: [
    {
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      version: 2,
      kind: 'WORKFLOW',
      manifestHash: 'a'.repeat(64),
      contentHash: 'b'.repeat(64),
      requiredToolCapabilities: [],
      artifactIntegrity: 'NOT_CHECKED_BODY_ON_REQUEST',
      lineageEvent: {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'ACTIVATE',
        resultingRevision: 6,
        eventHash: 'sha256:synthetic-rollback-target-fixture',
        createdAt: '2026-09-06T12:00:00.000Z',
      },
      compatibility: { status: 'CURRENTLY_AVAILABLE', missingCapabilities: [] },
      eligible: true,
    },
    {
      workflowVersionId: '66666666-6666-4666-8666-666666666666',
      version: 1,
      kind: 'WORKFLOW',
      manifestHash: 'c'.repeat(64),
      contentHash: 'd'.repeat(64),
      requiredToolCapabilities: ['fixture.unavailable'],
      artifactIntegrity: 'NOT_CHECKED_BODY_ON_REQUEST',
      lineageEvent: {
        id: '77777777-7777-4777-8777-777777777777',
        kind: 'ACTIVATE',
        resultingRevision: 5,
        eventHash: 'sha256:synthetic-ineligible-target-fixture',
        createdAt: '2026-09-05T12:00:00.000Z',
      },
      compatibility: { status: 'MISSING_TOOLS', missingCapabilities: ['fixture.unavailable'] },
      eligible: false,
    },
  ],
  nextTargetBefore: null,
}

function trpcSuccess(json: unknown) {
  return {
    contentType: 'application/json',
    body: JSON.stringify({ result: { data: { json } } }),
  }
}

test('workflow records and request-only transitions remain readable across viewports', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'phone-390x844')
    await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  const transitionRequests: unknown[] = []
  const transitionRequestBodies: string[] = []
  let transitionRequestAttempts = 0
  let applyAttempts = 0

  await page.route('**/api/trpc/admin.getAgentIdentity**', (route) =>
    route.fulfill(trpcSuccess({ agentType: 'QUALITY_REVIEW' })),
  )
  await page.route('**/api/trpc/admin.listAgentWorkflowActivations**', (route) =>
    route.fulfill(trpcSuccess(transitionHeads)),
  )
  await page.route('**/api/trpc/admin.getAgentWorkflowTransitionComposer**', (route) =>
    route.fulfill(trpcSuccess(transitionComposer)),
  )
  await page.route('**/api/trpc/admin.requestAgentWorkflowTransitionApproval**', (route) => {
    const body = route.request().postData()
    expect(body).not.toBeNull()
    transitionRequestBodies.push(body!)
    transitionRequests.push(route.request().postDataJSON()['0'].json)
    transitionRequestAttempts += 1
    if (transitionRequestAttempts === 1) return route.abort('failed')
    return route.fulfill(trpcSuccess({ approvalRequestId: 'synthetic-transition-request' }))
  })
  await page.route('**/api/trpc/admin.applyAgentWorkflowTransition**', (route) => {
    applyAttempts += 1
    return route.fulfill(trpcSuccess({}))
  })

  await page.goto(`${baseUrl}/dev-fixtures/agent-workflow-ledger`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await expect(page.getByRole('heading', { name: 'Workflow activation ledger' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Review a workflow canary' })).toBeVisible()
  const activation = page.locator('form').filter({ hasText: 'Candidate version' })
  const requestApproval = activation.getByRole('button', { name: 'Request human approval' })
  await expect(requestApproval).toBeDisabled()
  await activation
    .getByLabel('Candidate version')
    .selectOption('11111111-1111-4111-8111-111111111111')
  await activation.getByLabel('Bookkeeping identity').selectOption('identity-fixture')
  await expect(activation.getByText(/Development: 12 cases/)).toBeVisible()
  await expect(activation.getByText(/Eligible run type: QUALITY_REVIEW/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply reviewed activate' })).toBeVisible()
  await expect(page.getByText('Applied · revision 7')).toBeVisible()
  await page.getByText('Review approval terms').first().click()
  await expect(page.getByText('Expected head revision').first()).toBeVisible()
  await expect(
    page
      .getByText('fixture-visible-selection-salt-with-a-long-reviewable-value-1234567890')
      .first(),
  ).toBeVisible()
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible()

  const transition = page.locator('details').filter({ hasText: 'Change workflow activation' })
  await transition.locator('summary').click()
  await expect(
    transition.getByText(/human decision and a separate Apply remain required/i),
  ).toBeVisible()
  await transition.getByLabel('Recorded workflow head').selectOption('visitor-arrival')
  await expect(transition.getByText('Revision 7.')).toBeVisible()
  await expect(transition.getByLabel('Rollback target')).toBeEnabled()
  await expect(
    transition.getByRole('option', { name: /Version 1.*missing fixture\.unavailable/ }),
  ).toHaveJSProperty('disabled', true)
  await transition.getByLabel('Transition bookkeeping identity').selectOption('identity-fixture')
  await expect(transition.getByText(/Eligible run type: QUALITY_REVIEW/)).toBeVisible()
  await transition
    .getByLabel('Rollback target')
    .selectOption('00000000-0000-4000-8000-000000000001')
  await transition.getByLabel('Rollback selected numerator').fill('1')
  await transition.getByLabel('Rollback selection denominator').fill('10')
  await transition.getByLabel('Rollback maximum selected runs').fill('5')
  await transition
    .getByLabel('Rollback starts at (your local time; stored as UTC)')
    .fill('2026-09-08T09:00')
  await transition
    .getByLabel('Rollback ends at (your local time; stored as UTC)')
    .fill('2026-09-08T11:00')
  await transition.getByLabel('Rollback visible selection salt').fill('synthetic-rollback-salt')
  await transition.getByLabel('Rollback no-workflow baseline').check()
  await transition.getByLabel('Use canonical operator_task for rollback').check()
  await transition
    .getByLabel('Transition reason')
    .fill('Synthetic rollback request proves the reviewed request shape only.')
  const rollback = transition.getByRole('button', { name: 'Request rollback approval' })
  await expect(rollback).toBeEnabled()
  await rollback.focus()
  await expect(rollback).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations.map(
      ({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }),
    ),
  ).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath(`workflow-ledger-rollback-${page.viewportSize()?.width}.png`),
    fullPage: true,
  })
  if (testInfo.project.name === 'desktop-1440x900') {
    await page.setViewportSize({ width: 1024, height: 768 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath('workflow-ledger-rollback-laptop-1024.png'),
      fullPage: true,
    })
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  await rollback.click()
  await expect(
    transition.getByRole('button', { name: 'Retry exact transition request' }),
  ).toBeVisible()
  await expect(page.getByText(/request outcome is uncertain/i)).toBeVisible()
  await transition.getByRole('button', { name: 'Retry exact transition request' }).click()
  await expect(page.getByText(/Approval request recorded/i)).toBeVisible()

  await expect(transition.getByLabel('Recorded workflow head')).toBeEnabled()
  await transition.getByLabel('Recorded workflow head').selectOption('visitor-arrival')
  await expect(transition.getByText('Revision 7.')).toBeVisible()
  await transition.getByLabel('Workflow transition').selectOption('REVOKE')
  await expect(
    transition.getByText(/Revoke carries no workflow version or canary policy/),
  ).toBeVisible()
  await transition
    .getByLabel('Transition reason')
    .fill('Synthetic revoke request proves the reviewed request shape only.')
  const revoke = transition.getByRole('button', { name: 'Request revoke approval' })
  await expect(revoke).toBeEnabled()
  await revoke.click()

  await expect.poll(() => transitionRequestBodies.length).toBe(3)
  expect(transitionRequestBodies).toHaveLength(3)
  expect(transitionRequestBodies[0]).toBe(transitionRequestBodies[1])
  expect(transitionRequests).toHaveLength(3)
  expect(transitionRequests[0]).toEqual(transitionRequests[1])
  expect(transitionRequests[0]).toMatchObject({
    tenantId: 'fixture-tenant',
    venueId: 'fixture-venue',
    agentIdentityId: 'identity-fixture',
    registryKey: 'visitor-arrival',
    expectedHeadRevision: 7,
    kind: 'ROLLBACK',
    workflowVersionId: '00000000-0000-4000-8000-000000000001',
    reason: 'Synthetic rollback request proves the reviewed request shape only.',
    canaryPolicy: {
      numerator: 1,
      denominator: 10,
      maxSelectedRuns: 5,
      salt: 'synthetic-rollback-salt',
      eligibleRunTypes: ['QUALITY_REVIEW'],
      eligibleOperations: ['operator_task'],
      supportedActionClasses: ['RUN_TERMINAL_WRITE'],
      skippedBaseline: { kind: 'NO_WORKFLOW' },
    },
  })
  expect(transitionRequests[2]).toMatchObject({
    tenantId: 'fixture-tenant',
    venueId: 'fixture-venue',
    agentIdentityId: 'identity-fixture',
    registryKey: 'visitor-arrival',
    expectedHeadRevision: 7,
    kind: 'REVOKE',
    reason: 'Synthetic revoke request proves the reviewed request shape only.',
  })
  expect(transitionRequests[2]).not.toHaveProperty('workflowVersionId')
  expect(transitionRequests[2]).not.toHaveProperty('canaryPolicy')
  expect(applyAttempts).toBe(0)

  await expect(page.getByLabel('Decision reason (optional)')).toBeAttached()
  const decision = page.getByRole('button', { name: 'Record rejected decision' })
  await decision.focus()
  await expect(decision).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.screenshot({
    path: testInfo.outputPath(`workflow-ledger-${page.viewportSize()?.width}.png`),
    fullPage: true,
  })
})
