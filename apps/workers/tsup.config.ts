import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Bundle all workspace packages (they resolve to raw TS source in the monorepo)
  noExternal: [/^@pathfinder\//],
  // Do not bundle these — they have native binaries that must remain external
  external: ['@prisma/client', '.prisma/client'],
})
