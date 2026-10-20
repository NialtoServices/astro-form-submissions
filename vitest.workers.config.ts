import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const SRC_DIR = fileURLToPath(new URL('./src', import.meta.url))

// The parts of the toolkit whose behaviour rests on the Workers runtime itself (R2's conditional writes,
// FixedLengthStream, how workerd streams and parses a request body) run here, inside workerd, against a local
// R2 bucket. The rest of the suite runs on Node through vitest.config.ts.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-09-01',
        r2Buckets: ['UPLOADS']
      }
    })
  ],
  resolve: {
    alias: [{ find: /^#(.*)\.js$/, replacement: `${SRC_DIR}/$1.ts` }]
  },

  // workerd has no file system to read a fixture from, so a test imports one with `?inline`, which needs the
  // bundler to treat the fixture as an asset rather than a module.
  assetsInclude: ['**/tests/fixtures/files/*'],
  test: {
    include: ['tests/workers/**/*.workers-test.ts']
  }
})
