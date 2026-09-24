#!/usr/bin/env node
import path from 'node:path'
import { spawn } from 'node:child_process'
import { discoverOutreachCodex, loadOutreachProfile } from './lib/torchiko-outreach-discovery.mjs'
import { outreachMcpCodexArgs, outreachBridgeStatus } from './lib/torchiko-outreach-mcp.mjs'
import { outreachConnectionConfig } from './lib/torchiko-outreach-connection.mjs'
const root = path.resolve(import.meta.dirname, '..')
try {
  // Reject missing or malformed native admission before inspecting/launching a
  // model. Local doctors remain available; none is authentication evidence.
  if (process.argv.length === 3 && process.argv[2] === 'start') outreachConnectionConfig(process.env)
  const profile = await loadOutreachProfile(root), route = await discoverOutreachCodex()
  if (profile.model !== route.model) throw new Error('The reviewed outreach model does not match the installed Codex route.')
  if (process.argv.length === 2 || process.argv[2] === 'doctor') console.log(JSON.stringify({ ...route, outreachBridge: outreachBridgeStatus(),
    launchScopedMcp: 'torchiko_outreach; supplied only to this launched Codex process, no global config mutation' }, null, 2))
  else if (process.argv.length === 3 && process.argv[2] === 'start') {
    if (route.login !== 'EXISTING_CHATGPT_LOGIN') throw new Error('Existing Codex login was not confirmed. No account change was attempted.')
    // Interactive only. Start in the correct project without altering global
    // model/PATH/sandbox settings; native tools still enforce separate grants.
    const child = spawn(route.executable, [...outreachMcpCodexArgs(root), '-C', root, '--model', profile.model, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
      { cwd: root, stdio: 'inherit', shell: false, env: { ...process.env, TORCHIKO_CRM_VAULT: profile.vault } })
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    process.exitCode = exit ?? 1
  } else throw new Error('Usage: node scripts/torchiko-outreach-codex.mjs doctor|start')
} catch (error) { console.error(JSON.stringify({ error: error.code ?? error.message,
  operatorAction: outreachBridgeStatus().operatorAction, SEND_AUTHORIZED: false })); process.exitCode = 1 }
