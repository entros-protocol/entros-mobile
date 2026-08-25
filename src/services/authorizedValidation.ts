import type { WalletKind } from "@/state/types";
import * as mwa from "@/wallet/mwa";

import {
  type ValidateFeaturesRequestBody,
  type ValidateOutcome,
  validateFeaturesRequest,
} from "./executor";
import {
  buildValidationAuthorizationMessage,
  buildValidationRequestDigest,
  bytesToHex,
} from "./validationAuthorization";

const SIGNING_RESERVE_MS = 1_000;

type SignMessage = typeof mwa.signMessage;
type SendValidation = (request: ValidateFeaturesRequestBody) => Promise<ValidateOutcome>;

export type AuthorizedValidationResult =
  | { kind: "sent"; outcome: ValidateOutcome; authToken: string }
  | { kind: "cancelled" }
  | { kind: "expired" };

interface AuthorizedValidationArgs {
  requestBody: ValidateFeaturesRequestBody;
  nonce: Uint8Array;
  expiresAtMs: number;
  walletAddress: string;
  walletKind: WalletKind;
  authToken: string;
  onAuthTokenRotated: mwa.AuthTokenRotationHandler;
  isCancelled: () => boolean;
  now?: () => number;
  signMessage?: SignMessage;
  sendValidation?: SendValidation;
}

export async function authorizeAndSendValidation({
  requestBody,
  nonce,
  expiresAtMs,
  walletAddress,
  walletKind,
  authToken,
  onAuthTokenRotated,
  isCancelled,
  now = () => performance.now(),
  signMessage = mwa.signMessage,
  sendValidation = validateFeaturesRequest,
}: AuthorizedValidationArgs): Promise<AuthorizedValidationResult> {
  const remainingMs = expiresAtMs - now() - SIGNING_RESERVE_MS;
  if (remainingMs <= 0) return { kind: "expired" };

  const message = new TextEncoder().encode(
    buildValidationAuthorizationMessage(
      walletAddress,
      nonce,
      requestBody.projection_version,
      buildValidationRequestDigest(requestBody),
    ),
  );
  const authorization = await signMessage(
    authToken,
    message,
    walletAddress,
    walletKind,
    remainingMs,
    onAuthTokenRotated,
  );

  if (isCancelled()) return { kind: "cancelled" };
  if (now() >= expiresAtMs) return { kind: "expired" };

  requestBody.wallet_authorization = {
    nonce: Array.from(nonce),
    signature_hex: bytesToHex(authorization.signature),
  };

  if (isCancelled()) return { kind: "cancelled" };
  if (now() >= expiresAtMs) return { kind: "expired" };

  return {
    kind: "sent",
    outcome: await sendValidation(requestBody),
    authToken: authorization.authToken,
  };
}
