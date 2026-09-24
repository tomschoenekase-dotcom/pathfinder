import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assertAuthenticatedCrmSalesComponentsEnvironment,
  inspectAuthenticatedCrmSalesComponents,
  readAuthenticatedTorchikoWritingGuide,
  TORCHIKO_SAVED_WRITING_GUIDE_SOURCE,
} from './local-crm-sales-components'

describe('authenticated private CRM component boundary', () => {
  const bridge = join(tmpdir(), 'installed', 'component_bridge.py')
  const vault = join(tmpdir(), 'private-vault')
  const configured = {
    TORCHIKO_AUTHENTICATED_CRM_SALES_ENABLED: '1',
    TORCHIKO_CRM_SALES_BRIDGE: bridge,
    TORCHIKO_CRM_VAULT: vault,
  }

  it('requires an explicit installed owner and never inherits fixture authority', () => {
    expect(() => assertAuthenticatedCrmSalesComponentsEnvironment({})).toThrow('not configured')
    expect(() =>
      assertAuthenticatedCrmSalesComponentsEnvironment({
        ...configured,
        TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED: '1',
      }),
    ).toThrow('not configured')
    expect(() =>
      assertAuthenticatedCrmSalesComponentsEnvironment({
        ...configured,
        TORCHIKO_LOCAL_CRM_REHEARSAL: '1',
      }),
    ).toThrow('not configured')
    expect(() =>
      assertAuthenticatedCrmSalesComponentsEnvironment({
        ...configured,
        TORCHIKO_LOCAL_CRM_SALES_ENABLED: '1',
      }),
    ).toThrow('not configured')
    expect(() =>
      assertAuthenticatedCrmSalesComponentsEnvironment({
        ...configured,
        TORCHIKO_CRM_SALES_BRIDGE: 'component_bridge.py',
      }),
    ).toThrow('not configured')
    expect(assertAuthenticatedCrmSalesComponentsEnvironment(configured)).toBe(bridge)
  })

  it('distinguishes unconfigured, missing owner and readable exact guide without revealing paths', async () => {
    expect(await inspectAuthenticatedCrmSalesComponents({})).toMatchObject({
      state: 'unconfigured',
      guide: { state: 'unconfigured', sha256: null },
    })
    expect(await inspectAuthenticatedCrmSalesComponents(configured)).toMatchObject({
      state: 'unavailable',
      guide: { state: 'unavailable', sha256: null },
    })
    const root = await mkdtemp(join(tmpdir(), 'torchiko-guide-test-'))
    try {
      const installed = join(root, 'installed')
      const privateVault = join(root, 'vault')
      const selected = join(
        privateVault,
        '95 AI Staging',
        'Torchiko Sales Writing Reference 2026-09-21',
        'v0.2-r001',
      )
      await mkdir(installed)
      await mkdir(selected, { recursive: true })
      await writeFile(join(installed, 'component_bridge.py'), 'test bridge placeholder')
      const path = join(selected, 'TORCHIKO-WRITING-REFERENCE.md')
      const text = '# Exact selected writing guide\nKeep the owner wording.\n'
      await writeFile(path, text)
      const env = {
        ...configured,
        TORCHIKO_CRM_SALES_BRIDGE: join(installed, 'component_bridge.py'),
        TORCHIKO_CRM_VAULT: privateVault,
      }
      const expected = createHash('sha256').update(text).digest('hex')
      const readiness = await inspectAuthenticatedCrmSalesComponents(env)
      expect(readiness).toMatchObject({
        state: 'paths-present-runtime-unverified',
        guide: { state: 'available', sha256: expected },
      })
      expect(JSON.stringify(readiness)).not.toContain(root)
      expect(await readAuthenticatedTorchikoWritingGuide(env)).toEqual({
        label: 'Torchiko sales writing reference v0.2',
        sourceRef: TORCHIKO_SAVED_WRITING_GUIDE_SOURCE,
        text,
        sha256: expected,
      })
      await writeFile(path, 'x'.repeat(32_001))
      expect((await inspectAuthenticatedCrmSalesComponents(env)).guide).toEqual({
        state: 'unavailable',
        sha256: null,
      })
      await expect(readAuthenticatedTorchikoWritingGuide(env)).rejects.toThrow(
        'SELECTED_WRITING_GUIDE_UNAVAILABLE',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
