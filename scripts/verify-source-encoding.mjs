#!/usr/bin/env node
// Fails when a tracked text file contains U+FFFD, the replacement character an editor or script
// leaves behind when it decodes UTF-8 wrongly. A corrupted message once made a draft and its
// approval disagree, so every package with a duplicate title failed to import.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TEXT = /\.(?:[cm]?[jt]sx?|json|md|prisma|sql|ya?ml|css|html|txt)$/i
const files = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter((file) => file && TEXT.test(file))

const findings = []
for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (!text.includes('�')) continue
  text.split('\n').forEach((line, index) => {
    if (line.includes('�')) findings.push(`${file}:${index + 1}`)
  })
}

if (findings.length > 0) {
  console.error('Replacement characters (U+FFFD) found; restore the intended characters:')
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}
console.log(`Source encoding OK (${files.length} text files).`)
