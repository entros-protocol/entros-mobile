// Jest config for pure-JS / pure-TS unit tests. The mobile app itself runs
// under Hermes; we don't run RN-component tests here, so the jest-expo
// preset (which mocks the entire React Native runtime) is intentionally
// avoided. Tests that need to render components are out of scope until
// they're needed; for Stage 3 we only need to test the hashing layer,
// which is Buffer-free pure TS that runs identically on Node and Hermes.

// The `test` script sets NODE_OPTIONS=--experimental-vm-modules. Without it,
// any `await import(...)` inside the code under test throws "A dynamic import
// callback was invoked without --experimental-vm-modules", and the extraction
// modules swallow that in a try/catch and fall back to a zero feature vector.
// That failed silently rather than loudly: a test would see all zeros, compare
// them against other zeros, and pass. It is why no test in this repository had
// ever exercised Meyda, which supplies the spectra behind the voice-quality
// and MFCC features. Removing the flag re-hides that whole path.

module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["babel-jest", { presets: ["babel-preset-expo"] }],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
  // crypto.getRandomValues is available natively on Node 19+. CI uses
  // Node 20 (.nvmrc), local dev typically newer. No setup file needed.
};
