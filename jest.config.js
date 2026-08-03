/**
 * SDK unit tests. cosmjs's @noble/@scure transitive deps ship ESM-only; they
 * are whitelisted out of transformIgnorePatterns and transpiled to CJS by
 * ts-jest (allowJs) so the CommonJS runtime can load them. The real WASM
 * crypto round-trip runs here too (crypto-wasm.test.ts) — no devnet needed.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.+(ts|tsx|js)', '**/*.(test|spec).+(ts|tsx|js)'],
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/)'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  testTimeout: 30000,
};
