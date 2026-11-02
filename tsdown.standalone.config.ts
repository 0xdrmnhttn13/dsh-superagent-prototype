import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { daemon: 'src/standalone/daemon.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  // Keep the SDK and its optional native dependencies external; bundle only the standalone source closure.
})
