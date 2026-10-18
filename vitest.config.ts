/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import { getViteConfig } from 'astro/config'

const SRC_DIR = fileURLToPath(new URL('./src', import.meta.url))

// getViteConfig gives the tests Astro's own Vite setup, as a consuming site's build has. The modules under
// test are the TypeScript source; vitest.dist.config.ts runs the same suite against the compiled package.
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
