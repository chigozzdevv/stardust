import { defineConfig } from 'stardust-stellar';

export default defineConfig({
  network: 'testnet',
  app: { url: 'http://localhost:3000', start: 'node server.ts' },
  tests: '..',
});
