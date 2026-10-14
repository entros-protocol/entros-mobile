import {
  chargeAnchorRetry,
  EMPTY_ANCHOR_RETRY_BUDGET,
  MAX_ANCHOR_QUALITY_ATTEMPTS,
} from "../anchorRetry";

test("bounds baseline quality retries across fresh reset sessions", () => {
  let budget = chargeAnchorRetry(EMPTY_ANCHOR_RETRY_BUDGET, "wallet", "reset");
  expect(budget.used).toBe(1);
  for (let count = 2; count <= 6; count++) {
    budget = chargeAnchorRetry(budget, "wallet", "reset");
    expect(budget.intent).toBe("reset");
    expect(budget.used).toBe(Math.min(count, MAX_ANCHOR_QUALITY_ATTEMPTS));
  }
});

test("isolates wallets and explicit verify/reset intent changes", () => {
  let budget = chargeAnchorRetry(EMPTY_ANCHOR_RETRY_BUDGET, "wallet-a", "verify");
  budget = chargeAnchorRetry(budget, "wallet-a", "verify");
  expect(chargeAnchorRetry(budget, "wallet-b", "verify").used).toBe(1);
  expect(chargeAnchorRetry(budget, "wallet-a", "reset").used).toBe(1);
  expect(budget.used).toBe(2);
});
