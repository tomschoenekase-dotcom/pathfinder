import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        jakarta: ['var(--font-jakarta)', 'sans-serif'],
        portal: ['var(--font-portal-serif)', 'Georgia', 'serif'],
      },
      colors: {
        pf: {
          deep: '#0F2A4A',
          primary: '#1F4E8C',
          accent: '#3A7BD5',
          light: '#C9D4E3',
          surface: '#F2F5F9',
          white: '#FFFFFF',
        },
        // Client-portal home palette, derived from the --torchiko-* product tokens in
        // globals.css. Text pairs are checked against `paper` for WCAG AA.
        tk: {
          paper: '#FBFAF6',
          card: '#FFFEFB',
          ink: '#102F50',
          'ink-wash': '#E9EEF3',
          soft: '#52687E',
          rule: '#DDD6C8',
          'rule-strong': '#8C826E',
          ember: '#D4553A',
          'ember-text': '#A63F28',
          'ember-wash': '#FBEEE9',
          moss: '#2F6B55',
          focus: '#225B91',
          danger: '#9F2D2D',
        },
      },
    },
  },
  plugins: [],
}

export default config
