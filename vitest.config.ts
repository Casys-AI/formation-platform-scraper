import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Disable the Loki log transport at module-load time (src/utils.ts createLogger)
    // so importing src/config.ts never attempts a network connection during tests.
    env: {
      LOKI_ENABLED: 'false',
    },
  },
});
