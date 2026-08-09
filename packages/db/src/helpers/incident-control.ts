import {
  DEFAULT_GLOBAL_AI_CONTROL,
  GLOBAL_AI_CONTROL_KEY,
  parseGlobalAiControlValue,
  type GlobalAiControlValue,
} from '@pathfinder/config/incident-control'

import { db } from '../client'

type PlatformConfigClient = Pick<typeof db, 'platformConfig'>

export type GlobalAiControlState = GlobalAiControlValue & {
  configured: boolean
  malformed: boolean
  updatedAt: Date | null
  updatedBy: string | null
}

export class GlobalAiAdmissionError extends Error {
  readonly code:
    | 'global-ai-paused'
    | 'global-ai-control-malformed'
    | 'global-ai-control-unavailable'

  constructor(code: GlobalAiAdmissionError['code']) {
    super('Global AI admission is unavailable')
    this.name = 'GlobalAiAdmissionError'
    this.code = code
  }
}

export async function readGlobalAiControl(
  client: PlatformConfigClient = db,
): Promise<GlobalAiControlState> {
  const row = await client.platformConfig.findUnique({
    where: { key: GLOBAL_AI_CONTROL_KEY },
    select: { value: true, updatedAt: true, updatedBy: true },
  })

  if (!row) {
    return {
      ...DEFAULT_GLOBAL_AI_CONTROL,
      configured: false,
      malformed: false,
      updatedAt: null,
      updatedBy: null,
    }
  }

  const value = parseGlobalAiControlValue(row.value)
  if (!value) {
    return {
      ...DEFAULT_GLOBAL_AI_CONTROL,
      paused: true,
      configured: true,
      malformed: true,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    }
  }

  return {
    ...value,
    configured: true,
    malformed: false,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }
}

export async function assertGlobalAiAvailable(client: PlatformConfigClient = db): Promise<void> {
  let control: GlobalAiControlState
  try {
    control = await readGlobalAiControl(client)
  } catch {
    throw new GlobalAiAdmissionError('global-ai-control-unavailable')
  }
  if (control.malformed) throw new GlobalAiAdmissionError('global-ai-control-malformed')
  if (control.paused) throw new GlobalAiAdmissionError('global-ai-paused')
}
