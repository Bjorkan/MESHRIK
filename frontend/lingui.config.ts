import { defineConfig } from '@lingui/conf';

export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'sv'],
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['<rootDir>/src'],
      exclude: ['**/test/**', '**/*.test.*', '**/generated/**'],
    },
  ],
});
