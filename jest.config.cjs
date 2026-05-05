/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  watchman: false,
  rootDir: '.',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Route core package imports to their TS sources to avoid ESM-in-CJS surprises.
    '^@open-mercato/core/modules/(.*)$': '<rootDir>/node_modules/@open-mercato/core/src/modules/$1',
    '^@open-mercato/shared/lib/(.*)$': '<rootDir>/node_modules/@open-mercato/shared/src/lib/$1',
    '^@open-mercato/shared/modules/(.*)$': '<rootDir>/node_modules/@open-mercato/shared/src/modules/$1',
    '^@open-mercato/shared/security/(.*)$': '<rootDir>/node_modules/@open-mercato/shared/src/security/$1',
    '^@open-mercato/ui/(.*)$': '<rootDir>/node_modules/@open-mercato/ui/src/$1',
  },
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
          esModuleInterop: true,
          allowJs: true,
          target: 'ES2020',
          module: 'commonjs',
          moduleResolution: 'node',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
        diagnostics: false,
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.(ts|tsx)'],
  testPathIgnorePatterns: ['/node_modules/', '/.next/'],
  // Resolve @open-mercato/* package imports against their `src/` (TS sources)
  // instead of the shipped `dist/` ESM bundles, which Jest cannot load without ESM mode.
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
  transformIgnorePatterns: [
    '/node_modules/(?!(@open-mercato)/)',
  ],
  passWithNoTests: true,
}
