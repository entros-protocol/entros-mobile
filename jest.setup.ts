Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

// The Play Integrity module is native. Loading its real index would pull in
// the Expo runtime, which Node cannot run. Tests drive these mocks directly.
jest.mock("./modules/entros-play-integrity", () => ({
  EntrosPlayIntegrity: {
    prepare: jest.fn(() => Promise.resolve()),
    request: jest.fn(() => Promise.reject(new Error("Play Integrity is not available in Jest."))),
  },
}));
