/**
 * Inlines the built-in email .mustache sources into generated TypeScript modules.
 *
 * The .mustache files (in the top-level templates/ folder) are the authored source of truth, but
 * they can't be imported from the compiled package: `?raw` imports survive `tsc` into dist, where
 * Vite's esbuild dep optimizer (SSR dev pre-bundling) can't resolve them. Inlining at build time
 * keeps dist consumable by anything. Runs before build/check/test via the package scripts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const readTemplate = (name) => readFileSync(join(rootDir, 'templates', name), 'utf8')

// One entry per built-in email; each generates `src/dispatchers/<name>-sources.ts` with the same
// `htmlSource`/`textSource` exports. Add a new template's name here alongside its two .mustache files.
const templates = ['submission-notification', 'submission-acknowledgement']

for (const name of templates) {
  const module_ = `// Generated from templates/${name}.{html,txt}.mustache by scripts/generate-email-template-sources.mjs — do not edit.

/** The ${name} email's HTML document source (templates/${name}.html.mustache). */
export const htmlSource = ${JSON.stringify(readTemplate(`${name}.html.mustache`))}

/** The ${name} email's plain-text source (templates/${name}.txt.mustache). */
export const textSource = ${JSON.stringify(readTemplate(`${name}.txt.mustache`))}
`
  writeFileSync(join(rootDir, `src/dispatchers/${name}-sources.ts`), module_)
}
