export type SupportContentChainReceipt = {
  receiptId: string
  receiptKind: 'UNIVERSAL' | 'ADOPTION'
  proposalId: string
  sourceProposalId: string
  sourceRequestVersion: number
  replacementOfProposalId: string | null
  moduleId: string
  moduleKind: string
  revisionId: string
  revisionVersion: number
  classification: string | null
  relation: string | null
  expectedBaseRevisionId: string | null
  expectedBaseVersion: number | null
}

export class SupportContentChainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupportContentChainError'
  }
}

function assertSuccessorPair(receipt: SupportContentChainReceipt) {
  if (
    !(
      (receipt.classification === 'CORRECTION' && receipt.relation === 'CORRECTS') ||
      (receipt.classification === 'SUPERSESSION' && receipt.relation === 'SUPERSEDES')
    )
  )
    throw new SupportContentChainError(
      'A content receipt successor has an invalid semantic relation.',
    )
}

function assertReceiptShape(receipt: SupportContentChainReceipt) {
  const hasBase = receipt.expectedBaseRevisionId !== null || receipt.expectedBaseVersion !== null
  if (receipt.receiptKind === 'ADOPTION') {
    if (hasBase || receipt.classification !== null || receipt.relation !== null)
      throw new SupportContentChainError('An adoption receipt has invalid content-chain metadata.')
    return
  }
  if (receipt.classification === 'ADDITION' && receipt.relation === 'NEW_FACT') {
    if (hasBase)
      throw new SupportContentChainError('An addition receipt cannot have a content-chain base.')
    return
  }
  assertSuccessorPair(receipt)
  if (receipt.expectedBaseRevisionId === null || receipt.expectedBaseVersion === null)
    throw new SupportContentChainError(
      'A correction or supersession receipt requires an exact base.',
    )
  if (receipt.expectedBaseVersion + 1 !== receipt.revisionVersion)
    throw new SupportContentChainError(
      'A content receipt revision is not consecutive with its base.',
    )
}

/** Returns historical receipt IDs mapped to their only successor receipt ID. */
export function resolveSupportContentReceiptChains(receipts: SupportContentChainReceipt[]) {
  const successors = new Map<string, string>()
  const groups = new Map<string, SupportContentChainReceipt[]>()
  const allByRevisionId = new Map<string, SupportContentChainReceipt>()
  const kindByModuleId = new Map<string, string>()
  const receiptIds = new Set<string>()
  for (const receipt of receipts) {
    assertReceiptShape(receipt)
    if (receiptIds.has(receipt.receiptId))
      throw new SupportContentChainError('Content receipt chain has duplicate receipt identity.')
    receiptIds.add(receipt.receiptId)
    const existingKind = kindByModuleId.get(receipt.moduleId)
    if (existingKind && existingKind !== receipt.moduleKind)
      throw new SupportContentChainError('Content receipt chain has a module-kind mismatch.')
    kindByModuleId.set(receipt.moduleId, receipt.moduleKind)
    if (allByRevisionId.has(receipt.revisionId))
      throw new SupportContentChainError('Content receipt chain has duplicate revision identity.')
    allByRevisionId.set(receipt.revisionId, receipt)
    const key = `${receipt.moduleId}:${receipt.moduleKind}`
    groups.set(key, [...(groups.get(key) ?? []), receipt])
  }
  for (const group of groups.values()) {
    const byRevisionId = new Map<string, SupportContentChainReceipt>()
    for (const receipt of group) {
      if (byRevisionId.has(receipt.revisionId))
        throw new SupportContentChainError('Content receipt chain has duplicate revision identity.')
      byRevisionId.set(receipt.revisionId, receipt)
    }
    const incoming = new Set<string>()
    for (const receipt of group) {
      if (receipt.expectedBaseRevisionId === null || receipt.expectedBaseVersion === null) {
        continue
      }
      if (receipt.expectedBaseRevisionId === receipt.revisionId)
        throw new SupportContentChainError('A content receipt cannot base itself.')
      const predecessor = byRevisionId.get(receipt.expectedBaseRevisionId)
      if (!predecessor) {
        if (allByRevisionId.has(receipt.expectedBaseRevisionId))
          throw new SupportContentChainError('Content receipt chain has a foreign exact base.')
        continue
      }
      if (predecessor.revisionVersion !== receipt.expectedBaseVersion)
        throw new SupportContentChainError(
          'Content receipt chain has a missing or inconsistent exact base.',
        )
      if (predecessor.revisionVersion >= receipt.revisionVersion)
        throw new SupportContentChainError('Content receipt chain points to a local forward base.')
      const laterVersion = receipt.sourceRequestVersion > predecessor.sourceRequestVersion
      const explicitReplacement =
        receipt.sourceRequestVersion === predecessor.sourceRequestVersion &&
        receipt.replacementOfProposalId === predecessor.proposalId &&
        receipt.sourceProposalId === predecessor.proposalId
      if (!laterVersion && !explicitReplacement)
        throw new SupportContentChainError(
          'Content receipt chain source evidence does not move forward.',
        )
      if (successors.has(predecessor.receiptId))
        throw new SupportContentChainError('Content receipt chain forks from one base.')
      successors.set(predecessor.receiptId, receipt.receiptId)
      incoming.add(receipt.receiptId)
    }
    const roots = group.filter((receipt) => !incoming.has(receipt.receiptId))
    const terminals = group.filter((receipt) => !successors.has(receipt.receiptId))
    if (roots.length !== 1 || terminals.length !== 1)
      throw new SupportContentChainError(
        'Content receipt chain must have one unbroken root and terminal.',
      )
    const visited = new Set<string>()
    let current: string | undefined = roots[0]?.receiptId
    while (current) {
      if (visited.has(current))
        throw new SupportContentChainError('Content receipt chain contains a cycle.')
      visited.add(current)
      current = successors.get(current)
    }
    if (visited.size !== group.length)
      throw new SupportContentChainError('Content receipt chain is detached or incomplete.')
  }
  return successors
}
