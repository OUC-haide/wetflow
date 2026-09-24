import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    core: 'src/core/index.ts',
    agent: 'src/agent/index.ts',
    cordis: 'src/cordis.ts',
    server: 'src/server.ts',
    cli: 'src/cli.ts',
  },
  outDir: 'dist/node',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: true,
  external: ['cordis'],
})
