import { clearChallenge, peekChallenge, setChallenge, takeChallenge } from "../challengeBuffer";

const challenge = () => ({
  nonce: new Uint8Array(32).fill(7),
  phrase: "alpha beta gamma delta epsilon",
  expiresIn: 60,
  expiresAtMs: 61_000,
  projectionVersion: 2,
  curve: { a: 3, b: 5, delta: 1.25, points: 200, anchorX: 50, anchorY: 50 },
});

afterEach(clearChallenge);

describe("challenge buffer", () => {
  test("preserves every server field and clears only on take", () => {
    const source = challenge();
    setChallenge(source);
    source.nonce[0] = 99;
    source.curve.anchorX = 0;

    const peeked = peekChallenge();
    expect(peeked).toEqual(challenge());
    peeked!.nonce[1] = 99;
    peeked!.curve.anchorY = 0;
    expect(peekChallenge()).toEqual(challenge());
    expect(takeChallenge()).toEqual(challenge());
    expect(peekChallenge()).toBeNull();
  });
});
