import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'test/index': 'src/test/index.ts',
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', 'test/index': 'src/test/index.ts' } },
  clean: true,
  sourcemap: true,
  target: 'node22',
  platform: 'node',
});
