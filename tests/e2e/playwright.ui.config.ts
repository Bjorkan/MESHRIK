import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./ui-visual",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          },
        }
      : {}),
  },
  webServer: {
    command:
      "node_modules/.bin/vite --config ../tests/e2e/ui-fixtures/vite.config.ts --host 127.0.0.1 --port 4175",
    cwd: path.resolve(__dirname, "../../frontend"),
    port: 4175,
    reuseExistingServer: false,
  },
});
