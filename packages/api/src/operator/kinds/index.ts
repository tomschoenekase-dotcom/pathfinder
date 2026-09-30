import type { AnyOperatorProposalKind } from '../proposals'
import { appearanceUpdateKind } from './appearance'

/**
 * Every proposal kind the operator can create. Add a kind by writing one file next to
 * `appearance.ts` and listing it here; `createKindRegistry` rejects duplicate tools.
 */
export const OPERATOR_PROPOSAL_KINDS: readonly AnyOperatorProposalKind[] = [appearanceUpdateKind]

export { appearanceUpdateKind }
