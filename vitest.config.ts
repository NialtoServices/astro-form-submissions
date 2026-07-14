/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import { getViteConfig } from 'astro/config'

const SRC_DIR = fileURLToPath(new URL('./src', import.meta.url))

// getViteConfig reuses Astro's Vite resolution so tests run against the same module graph the
// consuming site's build would produce.
export default getViteConfig({
  resolve: {
    // The package.json "imports" map resolves "#*" to ./dist for consumers; tests must instead run
    // against the TypeScript source, so intercept the subpath before the default condition applies.
    alias: [{ find: /^#(.*)\.js$/, replacement: `${SRC_DIR}/$1.ts` }]
  },
  test: {
    environment: 'node'
  }
})
