// Return fixed categories only. Provider messages, URLs and environment stay private.
export function railwayRuntimeDiagnostic(child) {
  let message = typeof child.stderr === 'string' ? child.stderr : ''
  try {
    const result = JSON.parse(child.stdout)
    if (typeof result.error === 'string') message += '\n' + result.error
  } catch { /* Non-JSON output is never forwarded. */ }
  if (/unauthorized|not authorized|not authenticated|not signed in/iu.test(message)) return 'unauthorized'
  if (/permission|access denied|insufficient scope/iu.test(message)) return 'access-denied'
  if (/no linked project|no project specified/iu.test(message)) return 'project-context-missing'
  if (/project token/iu.test(message)) return 'project-token-resolution'
  if (/not found|no deployments/iu.test(message)) return 'resource-not-found'
  if (/unknown|unexpected argument/iu.test(message)) return 'invalid-cli-arguments'
  if (/cannot find module|module_not_found|syntaxerror/iu.test(message)) return 'cli-launch-failed'
  if (/timed? ?out|connect|network|dns/iu.test(message)) return 'network-failed'
  return 'runtime-query-failed'
}
