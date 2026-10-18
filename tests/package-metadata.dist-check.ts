import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))

const manifest = JSON.parse(readFileSync(`${ROOT_DIR}package.json`, 'utf8')) as {
  files: string[]
  exports: Record<string, Record<string, string>>
  imports: Record<string, Record<string, string>>
}

// Run only by vitest.dist.config.ts, after a build: it checks what a consumer would install.
describe('the published package metadata', () => {
  it('points every export at a file the build produced', () => {
    for (const [entry, conditions] of Object.entries(manifest.exports)) {
      for (const target of Object.values(conditions)) {
        expect(existsSync(`${ROOT_DIR}${target}`), `${entry} → ${target}`).toBe(true)
      }
    }
  })

  it('publishes the build, and resolves internal imports into it for consumers', () => {
    expect(manifest.files).toContain('dist')
    expect(manifest.imports['#*']?.default).toBe('./dist/*')
  })
})
