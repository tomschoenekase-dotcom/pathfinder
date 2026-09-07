import type { BuiltinRigFamily, FactoryState, RigFamily, SemanticRigCapabilities } from './types'

export interface RigDefinition {
  family: RigFamily
  requiredSlots: readonly string[]
  stateControls: Readonly<Record<FactoryState, readonly string[]>>
}

const common = {
  idle: ['breath'],
  attention: ['focus'],
  listening: ['listen'],
  thinking: ['think'],
  speaking: ['speechEnergy'],
  happy: ['expressionHappy'],
  sad: ['expressionSad'],
  success: ['celebrate'],
  error: ['recover'],
  reaction: ['react'],
} as const

export const RIGS: Readonly<Record<BuiltinRigFamily, RigDefinition>> = {
  'morph-v1': {
    family: 'morph-v1',
    requiredSlots: ['body', 'face'],
    stateControls: {
      ...common,
      speaking: ['speechEnergy', 'squash'],
      happy: ['expressionHappy', 'stretch'],
      reaction: ['react', 'squash'],
    },
  },
  'compact-creature-v1': {
    family: 'compact-creature-v1',
    requiredSlots: ['body', 'eyes', 'wings'],
    stateControls: {
      ...common,
      attention: ['focus', 'headTilt'],
      speaking: ['speechEnergy', 'beak'],
      happy: ['expressionHappy', 'wingLift'],
      reaction: ['react', 'wingFlutter'],
    },
  },
  'humanoid-v1': {
    family: 'humanoid-v1',
    requiredSlots: ['torso', 'head', 'leftArm', 'rightArm'],
    stateControls: {
      ...common,
      attention: ['focus', 'headTurn'],
      speaking: ['speechEnergy', 'mouth'],
      happy: ['expressionHappy', 'armLift'],
      sad: ['expressionSad', 'shoulderDrop'],
      reaction: ['react', 'armGesture'],
    },
  },
}

export function resolveRig(spec: {
  rigFamily: RigFamily
  rigCapabilities?: SemanticRigCapabilities
}): RigDefinition | undefined {
  if (spec.rigFamily in RIGS) return RIGS[spec.rigFamily as BuiltinRigFamily]
  const manifest = spec.rigCapabilities
  if (
    !manifest ||
    manifest.familyId !== spec.rigFamily ||
    !/^custom:[a-z0-9][a-z0-9-]{2,80}$/u.test(spec.rigFamily) ||
    manifest.requiredSlots.length < 1 ||
    manifest.requiredSlots.length > 32 ||
    new Set(manifest.requiredSlots).size !== manifest.requiredSlots.length
  )
    return undefined
  if (manifest.requiredSlots.some((slot) => !/^[a-z][a-zA-Z0-9]{0,63}$/u.test(slot)))
    return undefined
  const controls = Object.fromEntries(
    FACTORY_STATE_KEYS.map((state) => [state, manifest.stateControls[state] ?? []]),
  ) as Record<FactoryState, readonly string[]>
  if (
    Object.values(controls).some(
      (items) => items.length > 16 || items.some((item) => !/^[a-z][a-zA-Z0-9]{0,63}$/u.test(item)),
    )
  )
    return undefined
  return {
    family: manifest.familyId,
    requiredSlots: manifest.requiredSlots,
    stateControls: controls,
  }
}

const FACTORY_STATE_KEYS: readonly FactoryState[] = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'happy',
  'sad',
  'success',
  'error',
  'reaction',
]
