module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/tests/pending-acks.test.js',
    '<rootDir>/tests/runtime.test.js',
    '<rootDir>/tests/queue.test.js'
  ],
  testTimeout: 30000,
  clearMocks: true
};
