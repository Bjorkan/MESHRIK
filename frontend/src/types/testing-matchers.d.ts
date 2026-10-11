// Component tests live outside src/test/, but their Vitest matchers need
// these declarations even when Docker excludes src/test/setup.ts.
// This import is type-only; setup.ts still registers matchers at test runtime.
import '@testing-library/jest-dom/vitest';
