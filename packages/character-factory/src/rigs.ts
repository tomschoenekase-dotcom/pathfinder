import type { FactoryState, RigFamily } from './types'

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

export const RIGS: Readonly<Record<RigFamily, RigDefinition>> = {
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
