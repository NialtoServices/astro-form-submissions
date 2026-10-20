import { defineConfig, devices } from '@playwright/test'
import { FIXTURE_ORIGIN } from './tests/browser/fixture/shared.ts'

// The browser suite runs the built package in real browsers, against a fixture server of its own that Playwright
// starts for the run. `reuseExistingServer: false` makes the run fail rather than test whatever else is listening
// on the fixture's port. Run `pnpm build` first: the server serves `dist/`.
export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.browser.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: FIXTURE_ORIGIN,
    trace: 'on-first-retry'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: {
    command: 'node tests/browser/fixture/server.ts',
    url: `${FIXTURE_ORIGIN}/contact.html`,
    reuseExistingServer: false
  }
})
