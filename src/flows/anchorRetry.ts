import type { VerifyIntent } from "@/state/types";

export const MAX_ANCHOR_QUALITY_ATTEMPTS = 3;

export interface AnchorRetryBudget {
  wallet: string | null;
  intent: VerifyIntent;
  used: number;
}

export const EMPTY_ANCHOR_RETRY_BUDGET: Readonly<AnchorRetryBudget> = {
  wallet: null,
  intent: "verify",
  used: 0,
};

export function chargeAnchorRetry(
  prior: Readonly<AnchorRetryBudget>,
  wallet: string | null,
  intent: VerifyIntent,
): AnchorRetryBudget {
  const used = prior.wallet === wallet && prior.intent === intent ? prior.used : 0;
  return { wallet, intent, used: Math.min(used + 1, MAX_ANCHOR_QUALITY_ATTEMPTS) };
}
