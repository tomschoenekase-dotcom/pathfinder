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
      },
    },
  },
  plugins: [],
}

export default config
