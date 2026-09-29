const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { ESLint } = require('eslint')

const webDirectory = __dirname
const eslint = new ESLint({
  cwd: webDirectory,
  overrideConfigFile: path.join(webDirectory, '.eslintrc.cjs'),
})

async function lintSnippet(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath: path.join(webDirectory, filePath) })
  return result.messages.map(({ ruleId }) => ruleId)
}

test('visitor runtime code cannot use browser-native confirmation or alert dialogs', async () => {
  for (const code of [
    "confirm('Reset conversation?')",
    "window.confirm('Reset conversation?')",
    "window.alert('Something happened')",
    "prompt('Enter a value')",
  ]) {
    const rules = await lintSnippet(code, 'components/confirmation-guard.fixture.tsx')
    assert(
      rules.some((rule) => rule === 'no-alert' || rule === 'no-restricted-globals'),
      `Expected browser dialog call to fail lint: ${code}`,
    )
  }
})

test('test files can exercise dialog behavior without disabling rules inline', async () => {
  const rules = await lintSnippet(
    "window.confirm('Reset conversation?')",
    'components/confirmation-guard.test.tsx',
  )

  assert.equal(rules.includes('no-alert'), false)
  assert.equal(rules.includes('no-restricted-globals'), false)
})
