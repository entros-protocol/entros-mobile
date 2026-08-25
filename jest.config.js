// Jest runs pure TypeScript tests in Node without mocking the React Native runtime.
// The test script enables VM modules so dynamic Meyda imports execute.
// Without this flag, extraction can return fallback vectors and hide parity defects.

module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["babel-jest", { presets: ["babel-preset-expo"] }],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
  // Node 24 provides crypto.getRandomValues without a setup file.
};
