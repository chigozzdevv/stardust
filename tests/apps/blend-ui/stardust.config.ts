import { defineConfig } from 'stardust-stellar';

export default defineConfig({
  network: 'testnet',
  app: {
    url: 'http://localhost:3000',
    start: 'python3 -m http.server 3000 --directory out',
  },
  tests: './stardust-e2e',
});
