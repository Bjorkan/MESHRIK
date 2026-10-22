# Isolated UI browser regressions

From `tests/e2e`, run `npx playwright test --config playwright.ui.config.ts`.
Install Chromium with `npx playwright install chromium` if needed, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chromium executable.

These fixtures mount production components and styles without a backend or radio.
The PathModal suite checks actual text/button geometry at 320, 375, 390 and 1024
CSS pixels, 100/200% root text size, longer explanations, and keyboard resend
semantics using a local callback. It sends no radio messages. Chromium layout
coverage does not claim physical iPhone Safari validation.

The Radio Activity suite uses intercepted synthetic API responses to exercise
pending, failed, retried, empty and filled history at 375/1280px. It verifies
background-job filtering, bounded scroll height, horizontal overflow, keyboard
scrolling/focus escape and responsive column count with the real Query hooks.
