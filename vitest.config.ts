import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkgs = ['contract', 'core', 'server', 'host', 'actions', 'rules', 'testkit', 'store-dynamodb'];
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      pkgs.map((p) => [`@agentevents/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))]),
    ),
  },
  // Tests never call a real model, whatever the shell exports; examples default to scripted models.
  test: { env: { AGENTEVENTS_MODEL: 'scripted', ANTHROPIC_API_KEY: '', AWS_BEARER_TOKEN_BEDROCK: '' }, include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'] },
});
