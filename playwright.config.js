// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  globalSetup: require.resolve('./tests/browser/global-setup.js'),

  // The page under test is a file:// URL with the whole viewer inlined, so
  // there is no server to start and no baseURL.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  // junit.xml feeds the test table on the CI run summary (#29).
  reporter: process.env.CI
    ? [['html'], ['list'], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : 'list',

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: /@firefox/,
    },
    // Tests of drawing that differs between browsers, tagged @firefox.
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      grep: /@firefox/,
    },
  ],
});
