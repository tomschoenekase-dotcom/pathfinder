import { createSafeOperationalMcpRegistry } from '../../mcp/composition'

export function currentCallableCapabilities() {
  return new Set(
    createSafeOperationalMcpRegistry()
      .listTools()
      .map((definition) => definition._meta['com.pathfinder/security'].capability),
  )
}
