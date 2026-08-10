import { Keypair, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";

import { type AnchorProgram, type BuildContext, buildResetIdentityStateIx } from "../instructions";

function context() {
  const walletPubkey = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey;
  let remainingAccounts: {
    pubkey: typeof SYSVAR_INSTRUCTIONS_PUBKEY;
    isSigner: boolean;
    isWritable: boolean;
  }[] = [];

  const builder = {
    accounts: () => builder,
    remainingAccounts: (accounts: typeof remainingAccounts) => {
      remainingAccounts = accounts;
      return builder;
    },
    instruction: async () =>
      new TransactionInstruction({
        programId,
        keys: remainingAccounts,
      }),
  };
  const anchorProgram = {
    programId,
    methods: {
      resetIdentityState: () => builder,
    },
  } as unknown as AnchorProgram;

  return {
    ctx: {
      anchorProgram,
      verifierProgram: anchorProgram,
      registryProgramId: Keypair.generate().publicKey,
      walletPubkey,
    } satisfies BuildContext,
  };
}

describe("reset identity instruction", () => {
  test("keeps the version 0 account layout unchanged", async () => {
    const { ctx } = context();
    const instruction = await buildResetIdentityStateIx(ctx, new Uint8Array(32), 0);

    expect(instruction.keys).toEqual([]);
  });

  test("passes the instructions sysvar as the sole versioned remaining account", async () => {
    const { ctx } = context();
    const instruction = await buildResetIdentityStateIx(ctx, new Uint8Array(32), 1);

    expect(instruction.keys).toEqual([
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ]);
  });
});
