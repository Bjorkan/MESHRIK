import { defineConfig } from "@playwright/test";
import path from "path";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./chart-visual",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1280, height: 1600 },
    colorScheme: "dark",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command:
      "../../../frontend/node_modules/.bin/vite --host 127.0.0.1 --port 4174",
    cwd: path.resolve(__dirname, "chart-fixtures"),
    port: 4174,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
