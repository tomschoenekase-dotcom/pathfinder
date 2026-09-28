// Next's test-only NEXT_FONT_GOOGLE_MOCKED_RESPONSES hook reads this file.
// Keep the disposable stack off Google Fonts while preserving font-family CSS.
const families = new Set([
  'DM Sans',
  'Inter',
  'Playfair Display',
  'Plus Jakarta Sans',
  'Poppins',
  'Space Grotesk',
])

module.exports = new Proxy(Object.create(null), {
  get(_target, key) {
    if (typeof key !== 'string') return undefined
    let url
    try {
      url = new URL(key)
    } catch {
      return undefined
    }
    if (url.origin !== 'https://fonts.googleapis.com' || url.pathname !== '/css2') {
      return undefined
    }
    const family = url.searchParams.get('family')?.split(':', 1)[0]
    if (!family || !families.has(family)) return undefined
    return `@font-face { font-family: '${family}'; src: local('Arial'); font-style: normal; font-weight: 100 900; }`
  },
})
