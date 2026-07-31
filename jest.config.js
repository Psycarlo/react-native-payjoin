/**
 * The wrapper tests mock `src/generated/payjoin` entirely, so no native
 * module (and no react-native runtime) is ever loaded — plain node is enough.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
};
