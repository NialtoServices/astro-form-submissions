/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import { getViteConfig } from 'astro/config'

const DIST_DIR = fileURLToPath(new URL('./dist', import.meta.url))

// The suite again, against the compiled package a consumer installs rather than the TypeScript source, so a
// build that drops or breaks something fails here before it can be published. Run after `pnpm build`.
export default getViteConfig({
  resolve: {
    alias: [{ find: /^#(.*)\.js$/, replacement: `${DIST_DIR}/$1.js` }]
  },
  test: {
    environment: 'node'
  }
})
