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
          ink: '#102F50',
          soft: '#52687E',
          rule: '#DDD6C8',
          ember: '#D4553A',
          'ember-text': '#A63F28',
          moss: '#2F6B55',
          focus: '#225B91',
        },
      },
    },
  },
  plugins: [],
}

export default config
