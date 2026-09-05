import * as mwa from "@/wallet/mwa";

import { submitProofIdentityUpgrade, submitRebaseline, submitReset, submitVerify } from "../submit";

jest.mock("@/wallet/mwa", () => ({ signAndSendTransaction: jest.fn() }));
jest.mock("@/config", () => ({
  config: { proofManifest: { genesisHash: "expected-network" } },
  getConnection: () => ({ getGenesisHash: async () => "different-network" }),
}));

const base = { walletAddress: "unused", authToken: "synthetic", walletKind: "phantom" as const };
const commitment = new Uint8Array(32);

describe("bound deployment network before signing", () => {
  it.each([
    ["mint", () => submitVerify({ ...base, commitment, isFirstVerify: true })],
    ["update", () => submitVerify({ ...base, commitment, isFirstVerify: false })],
    ["reset", () => submitReset({ ...base, commitment, projectionVersion: 0 })],
    ["layout upgrade", () => submitProofIdentityUpgrade(base)],
    [
      "rebaseline",
      () =>
        submitRebaseline({
          ...base,
          commitment,
          projectionVersion: 1,
          signedReceipt: { validator_pubkey_hex: "", message_hex: "", signature_hex: "" },
        }),
    ],
  ] as const)(
    "rejects %s on a different network before requesting a signature",
    async (_name, submit) => {
      await expect(submit()).rejects.toThrow("does not match this network");
      expect(mwa.signAndSendTransaction).not.toHaveBeenCalled();
    },
  );
});
