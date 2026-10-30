import type { LocalLunaPlannerProfile } from '@pathfinder/ai'
import { guestQueryChatExperimentEnabled } from './guest-query-chat-experiment'
/** Local server-only experiment selector. Never accepted from guest input/configuration rows. */
export function localGuestLunaPlannerProfile(input: { nodeEnv: string | undefined; enabled: string | undefined; experienceScope: string; nativePath: string; selected: string | undefined }): LocalLunaPlannerProfile | undefined {
  if (!guestQueryChatExperimentEnabled(input)) return undefined
  if (input.selected === undefined || input.selected === '') return undefined
  if (input.selected === 'standard') return 'LOCAL_LUNA_STANDARD_V1'
  if (input.selected === 'fast') return 'LOCAL_LUNA_FAST_V1'
  throw new Error('Invalid local Luna planner profile')
}
