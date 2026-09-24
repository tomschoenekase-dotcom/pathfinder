import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export async function loadOutreachProfile(root) {
  const profile = JSON.parse(await readFile(path.join(root, '.agents/skills/torchiko-outreach/runtime-profile.json'), 'utf8'))
  if (profile.schema !== 'torchiko.outreach-runtime-profile/1' || profile.sender !== 'tomschoenekase@torchiko.com' ||
      profile.model !== 'gpt-6-sol' ||
      profile.deliveryEnabled !== false || typeof profile.vault !== 'string' || !path.isAbsolute(profile.vault))
    throw new Error('The reviewed private outreach runtime profile is invalid; do not guess an account or source path.')
  const vault = await realpath(profile.vault)
  if (!(await stat(vault)).isDirectory()) throw new Error('Selected private vault is unavailable.')
  return { ...profile, vault }
}
export function parseCodexVersion(text) {
  const match = String(text).match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)([^\s]*)/u)
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    prerelease: match[4], text: match[0] } : null
}
/** Inspect only known installed binary locations. No install, PATH/config edit,
 * secret read, arbitrary recursive scan or unsupported-model substitution. */
export async function discoverOutreachCodex({ localAppData = process.env.LOCALAPPDATA,
  run = (file, args) => spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 }) } = {}) {
  if (!localAppData || !path.isAbsolute(localAppData)) throw new Error('Windows LOCALAPPDATA is required to inspect the installed Codex binaries.')
  const candidates = [path.join(localAppData, 'Programs/OpenAI/Codex/bin/codex.exe')]
  const currentRoot = path.join(localAppData, 'OpenAI/Codex/bin')
  let entries = []
  try { entries = await readdir(currentRoot, { withFileTypes: true }) } catch {}
  if (entries.length > 30) throw new Error('Installed Codex directory exceeds the bounded discovery limit; review the installation.')
  for (const entry of entries) if (entry.isDirectory() && /^[a-f0-9]{8,64}$/iu.test(entry.name)) candidates.push(path.join(currentRoot, entry.name, 'codex.exe'))
  const installed = []
  for (const file of candidates) {
    try { if (!(await stat(file)).isFile()) continue } catch { continue }
    const result = run(file, ['--version']), version = parseCodexVersion(result.stdout)
    if (result.status === 0 && version) installed.push({ file, version })
  }
  installed.sort((a, b) => b.version.major - a.version.major || b.version.minor - a.version.minor || b.version.patch - a.version.patch)
  const chosen = installed.find(v => v.version.major > 0 || v.version.minor >= 155)
  if (!chosen) throw new Error('No compatible already-installed Codex was found. No upgrade or authentication change was attempted.')
  const login = run(chosen.file, ['login', 'status'])
  const statusText = String(login.stdout ?? '') + String(login.stderr ?? '')
  return { schema: 'torchiko.codex-operating-route/1', executable: chosen.file,
    version: chosen.version.text, model: 'gpt-6-sol',
    login: login.status === 0 && /logged in using chatgpt/iu.test(statusText) ? 'EXISTING_CHATGPT_LOGIN' : 'AUTHENTICATION_NOT_CONFIRMED',
    inspected: installed.map(v => ({ executable: v.file, version: v.version.text })),
    nativeCrmAuthentication: 'SEPARATE_LIVE_GRANT_REQUIRED', mailboxAuthentication: 'SEPARATE_COMPANY_ACCOUNT_REQUIRED',
    globalConfigurationChanged: false, SEND_AUTHORIZED: false }
}
