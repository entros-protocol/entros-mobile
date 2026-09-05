import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { type Connection, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

import {
  type NativeProofManifest,
  type PreparedNativeProofRequest,
  prepareNativeProofRequest,
  validateNativeProofManifest,
} from "@/proof/request";

export function proofRequestStateAddress(wallet: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proof_request_state"), wallet.toBytes()],
    program,
  )[0];
}

function discriminator(name: string): Uint8Array {
  return sha256(
    new Uint8Array(Array.from(`account:${name}`, (character) => character.charCodeAt(0))),
  ).subarray(0, 8);
}

export class NativeIdentityLayoutUpgradeRequired extends Error {
  constructor() {
    super("The identity account requires an authenticated layout upgrade before proving.");
    this.name = "NativeIdentityLayoutUpgradeRequired";
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export async function readNativeProofRequest(
  connection: Pick<Connection, "getGenesisHash" | "getMultipleAccountsInfoAndContext">,
  manifest: NativeProofManifest,
  wallet: string,
  nonce: Uint8Array,
  commitments: {
    commitmentNew: string;
    commitmentPrevious: string;
    threshold: number;
    minDistance: number;
  },
): Promise<PreparedNativeProofRequest> {
  const checked = validateNativeProofManifest(manifest);
  const owner = new PublicKey(wallet);
  const anchor = new PublicKey(checked.consumerProgram);
  const [identity, identityBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), owner.toBytes()],
    anchor,
  );
  const [requestState, requestBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("proof_request_state"), owner.toBytes()],
    anchor,
  );
  const [genesis, snapshot] = await Promise.all([
    connection.getGenesisHash(),
    connection.getMultipleAccountsInfoAndContext(
      [identity, requestState, SYSVAR_CLOCK_PUBKEY],
      "confirmed",
    ),
  ]);
  if (genesis !== checked.genesisHash)
    throw new Error("The proof deployment does not match this network.");
  const [identityAccount, counterAccount, clockAccount] = snapshot.value;
  if (
    !identityAccount ||
    identityAccount.executable ||
    !identityAccount.owner.equals(anchor) ||
    ![543, 551, 583, 593].includes(identityAccount.data.length) ||
    !equal(identityAccount.data.subarray(0, 8), discriminator("IdentityState")) ||
    !equal(identityAccount.data.subarray(8, 40), owner.toBytes()) ||
    identityAccount.data[126] !== identityBump
  )
    throw new Error("Invalid identity account for proof preparation.");
  const mint = PublicKey.findProgramAddressSync([Buffer.from("mint"), owner.toBytes()], anchor)[0];
  if (!equal(identityAccount.data.subarray(94, 126), mint.toBytes())) {
    throw new Error("Invalid identity mint for proof preparation.");
  }
  if (identityAccount.data.length !== 593) throw new NativeIdentityLayoutUpgradeRequired();
  if (
    !clockAccount ||
    clockAccount.executable ||
    clockAccount.data.length !== 40 ||
    !clockAccount.owner.equals(new PublicKey("Sysvar1111111111111111111111111111111111111"))
  )
    throw new Error("The chain clock is unavailable.");
  const clock = new DataView(
    clockAccount.data.buffer,
    clockAccount.data.byteOffset,
    clockAccount.data.byteLength,
  ).getBigInt64(32, true);
  if (clock <= 0n) throw new Error("Invalid chain clock.");
  let counter = 0n;
  const uninitialized =
    counterAccount &&
    !counterAccount.executable &&
    counterAccount.owner.equals(SystemProgram.programId) &&
    counterAccount.data.length === 0;
  if (counterAccount && !uninitialized) {
    if (
      counterAccount.executable ||
      !counterAccount.owner.equals(anchor) ||
      counterAccount.data.length !== 50 ||
      !equal(counterAccount.data.subarray(0, 8), discriminator("ProofRequestState")) ||
      counterAccount.data[8] !== 1 ||
      !equal(counterAccount.data.subarray(9, 41), owner.toBytes()) ||
      counterAccount.data[49] !== requestBump
    )
      throw new Error("Invalid persistent proof request state.");
    counter = new DataView(
      counterAccount.data.buffer,
      counterAccount.data.byteOffset,
      counterAccount.data.byteLength,
    ).getBigUint64(41, true);
  }
  if (counter === (1n << 64n) - 1n) throw new Error("The proof request counter is exhausted.");
  const data = identityAccount.data;
  if (bytesToHex(data.subarray(62, 94)) !== commitments.commitmentPrevious) {
    throw new Error("The baseline commitment changed before proving.");
  }
  return prepareNativeProofRequest(checked, wallet, bytesToHex(nonce), {
    ...commitments,
    identity: identity.toBase58(),
    mint: new PublicKey(data.subarray(94, 126)).toBase58(),
    counter,
    projectionVersion: data.readUInt16LE(583),
    validUntil: clock + 180n,
  });
}
