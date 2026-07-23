import { defineConfig } from "@playwright/test";

const desktopProjects = [
  { name: "desktop-1024", viewport: { width: 1024, height: 720 } },
  { name: "desktop-1280", viewport: { width: 1280, height: 800 } },
  { name: "desktop-1440", viewport: { width: 1440, height: 900 } },
] as const;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "line",
  use: {
    baseURL: "http://127.0.0.1:3000",
    browserName: "chromium",
    colorScheme: "light",
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: desktopProjects.map(({ name, viewport }) => ({
    name,
    use: { viewport },
  })),
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000/api/health/live",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      APP_MODE: "demo",
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    },
  },
});
