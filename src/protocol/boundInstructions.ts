import { BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  canonicalScalar,
  expectedNativePublicSignals,
  hex32,
  type NativeProofManifest,
  validatePreparedNativeProofRequest,
} from "@/proof/request";
import type { SolanaProof } from "@/proof/types";

import { type BuildContext, type RuntimeProgram, type UpdateReceiptArgs } from "./instructions";
import { findProtocolConfigPda, findTreasuryPda } from "./pdas";
import { proofRequestStateAddress } from "./proofRequest";
import {
  buildEd25519ReceiptIx,
  decodeSignedReceipt,
  receiptMatchesBinding,
  type SignedReceiptDto,
} from "./receipt";

export interface BoundPrograms {
  anchor: RuntimeProgram<"prepareProofRequest" | "updateAnchorBound" | "upgradeIdentityLayout">;
  verifier: RuntimeProgram<"verifyProofBound">;
}

export async function buildBoundProofInstructions(
  ctx: BuildContext,
  programs: BoundPrograms,
  manifest: NativeProofManifest,
  proof: SolanaProof,
  commitment: Uint8Array,
  nonce: readonly number[],
  signedReceipt?: SignedReceiptDto,
): Promise<TransactionInstruction[]> {
  if (!proof.preparedRequest) throw new Error("The proof request is missing.");
  const prepared = validatePreparedNativeProofRequest(proof.preparedRequest);
  if (
    prepared.wallet !== ctx.walletPubkey.toBase58() ||
    prepared.manifest.consumerProgram !== ctx.anchorProgram.programId.toBase58() ||
    prepared.manifest.verifierProgram !== ctx.verifierProgram.programId.toBase58() ||
    prepared.manifest.deploymentDomain !== manifest.deploymentDomain ||
    prepared.manifest.genesisHash !== manifest.genesisHash ||
    prepared.manifest.zkey.sha256 !== manifest.zkey.sha256
  )
    throw new Error("The proof request does not match the configured wallet or deployment.");
  if (proof.proofBytes.length !== 256) throw new Error("Invalid proof byte length.");
  const expected = expectedNativePublicSignals(prepared).map(canonicalScalar);
  if (
    proof.publicInputs.length !== expected.length ||
    expected.some(
      (bytes, index) =>
        bytes.length !== proof.publicInputs[index]?.length ||
        bytes.some((byte, offset) => byte !== proof.publicInputs[index]?.[offset]),
    )
  ) {
    throw new Error("The proof does not match its prepared public inputs.");
  }
  const nonceBytes = hex32(prepared.nonce);
  if (nonce.length !== 32 || nonce.some((byte, index) => byte !== nonceBytes[index])) {
    throw new Error("The submission nonce differs from the proof request.");
  }
  const commitmentBytes = hex32(prepared.action.commitmentNew);
  if (
    commitment.length !== 32 ||
    commitment.some((byte, index) => byte !== commitmentBytes[index])
  ) {
    throw new Error("The submission commitment differs from the proof request.");
  }
  if (!signedReceipt) {
    throw new Error("Returning verification requires a validator-signed update receipt.");
  }
  const decoded = decodeSignedReceipt(signedReceipt);
  if (
    !decoded ||
    decoded.version !== 4 ||
    !receiptMatchesBinding(signedReceipt, {
      purpose: 4,
      projectionVersion: prepared.action.projectionVersion,
      wallet: ctx.walletPubkey.toBytes(),
      commitment: commitmentBytes,
    })
  ) {
    throw new Error("The validator-signed update receipt is malformed.");
  }
  const receiptIx = buildEd25519ReceiptIx(signedReceipt);
  if (!receiptIx) {
    throw new Error("The validator-signed update receipt is malformed.");
  }
  const receiptArgs: UpdateReceiptArgs = {
    validatedAt: new BN(decoded.validatedAt.toString()),
    assuranceTier: decoded.assuranceTier ?? 0,
    sessionFinalDigest: decoded.sessionFinalDigest,
  };
  const state = proofRequestStateAddress(ctx.walletPubkey, ctx.anchorProgram.programId);
  const result = PublicKey.findProgramAddressSync(
    [Buffer.from("verification_bound"), ctx.walletPubkey.toBytes(), nonceBytes],
    ctx.verifierProgram.programId,
  )[0];
  const prepare = await programs.anchor.methods
    .prepareProofRequest()
    .accounts({
      authority: ctx.walletPubkey,
      proofRequestState: state,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const verify = await programs.verifier.methods
    .verifyProofBound(
      Array.from(nonceBytes),
      Array.from(proof.proofBytes),
      Array.from(commitmentBytes),
      Array.from(hex32(prepared.action.commitmentPrevious)),
      prepared.action.threshold,
      prepared.action.minDistance,
      new BN(prepared.action.validUntil.toString()),
    )
    .accounts({
      verifier: ctx.walletPubkey,
      verificationResult: result,
      identityState: new PublicKey(prepared.action.identity),
      proofRequestState: state,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const update = await programs.anchor.methods
    .updateAnchorBound(receiptArgs)
    .accounts({
      authority: ctx.walletPubkey,
      identityState: new PublicKey(prepared.action.identity),
      proofRequestState: state,
      verificationResult: result,
      protocolConfig: findProtocolConfigPda(ctx.registryProgramId),
      treasury: findTreasuryPda(ctx.registryProgramId),
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      verifierProgram: ctx.verifierProgram.programId,
    })
    .instruction();
  return [prepare, verify, receiptIx, update];
}
