import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE = `http://localhost:${PORT}${(process.env.VITE_BASE_PATH ?? '/').replace(/\/?$/, '/')}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    // iPhone portrait viewport; Chromium engine because only its binaries are installed here.
    ...devices['iPhone 13'],
    browserName: 'chromium',
    permissions: ['microphone'],
    defaultBrowserType: 'chromium',
    launchOptions: {
      // Fake microphone so the Listening state is testable without a device.
      args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
