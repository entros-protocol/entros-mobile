// Proof shapes match pulse-sdk/src/proof/types.ts so
// the JSON shape mopro emits and the byte layout we serialise for
// groth16-solana stay aligned with the web SDK's existing contract.

/** Serialised proof ready for on-chain submission via entros_verifier. */
export interface SolanaProof {
  proofBytes: Uint8Array;
  publicInputs: Uint8Array[];
  preparedRequest?: import("./request").PreparedNativeProofRequest;
}

/** Decimal proof coordinates after adapting the native or browser output. */
export interface RawProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

/** Witness input for the entros_hamming circuit. Field names match
 *  circuits/circom/entros_hamming.circom signal names exactly. */
export interface CircuitInput {
  ft_new: number[];
  ft_prev: number[];
  salt_new: string;
  salt_prev: string;
  commitment_new: string;
  commitment_prev: string;
  threshold: string;
  min_distance: string;
  request_digest_hi?: string;
  request_digest_lo?: string;
}

/** Proof generation result before serialisation. */
export interface ProofResult {
  proof: RawProof;
  publicSignals: string[];
}
