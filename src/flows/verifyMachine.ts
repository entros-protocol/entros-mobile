import { FailureBucket } from "@/state/types";

export type VerifyState =
  | "idle"
  | "countdown"
  | "capturing"
  | "extracting"
  | "validating"
  | "computing"
  | "signing"
  | "submitting"
  | "success"
  | "failure";

export type VerifyEvent =
  | { type: "start" }
  | { type: "advance" }
  | { type: "fail"; bucket: FailureBucket }
  | { type: "reset" };

export interface VerifyContext {
  state: VerifyState;
  failureBucket: FailureBucket | null;
}

export const initialContext: VerifyContext = { state: "idle", failureBucket: null };

const sequence: VerifyState[] = [
  "countdown",
  "capturing",
  "extracting",
  "validating",
  "computing",
  "signing",
  "submitting",
  "success",
];

export const next = (current: VerifyState): VerifyState => {
  const idx = sequence.indexOf(current);
  if (idx < 0 || idx >= sequence.length - 1) return current;
  return sequence[idx + 1]!;
};

export const reduce = (ctx: VerifyContext, event: VerifyEvent): VerifyContext => {
  switch (event.type) {
    case "start":
      return { state: "countdown", failureBucket: null };
    case "advance":
      return { ...ctx, state: next(ctx.state) };
    case "fail":
      return { state: "failure", failureBucket: event.bucket };
    case "reset":
      return initialContext;
    default:
      return ctx;
  }
};

export const stageDurationsMs: Partial<Record<VerifyState, number>> = {
  countdown: 3_000,
  capturing: 12_000,
  extracting: 1_200,
  validating: 1_000,
  computing: 1_600,
  signing: 1_000,
  submitting: 1_400,
};

export const stageCopy: Record<
  VerifyState,
  { title: string; subtitle?: string; spinnerColor?: "accent" | "purple" } | null
> = {
  idle: null,
  countdown: null,
  capturing: null,
  extracting: {
    title: "Extracting features",
    subtitle: "Voice, motion, and touch reduced to 308 numbers.",
  },
  validating: {
    title: "Server-side validation",
    subtitle: "Anti-replay and challenge-binding checks.",
  },
  computing: { title: "Generating ZK proof", subtitle: "Proving consistency, on-device." },
  signing: {
    title: "Waiting for wallet signature",
    subtitle: "Approve in your wallet.",
    spinnerColor: "purple",
  },
  submitting: { title: "Writing on-chain", subtitle: "Confirming on Solana devnet." },
  success: null,
  failure: null,
};
