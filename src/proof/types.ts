// Stage 6 proof shapes. Verbatim port of pulse-sdk/src/proof/types.ts so
// the JSON shape mopro emits and the byte layout we serialise for
// groth16-solana stay aligned with the web SDK's existing contract.

/** Serialised proof ready for on-chain submission via entros_verifier. */
export interface SolanaProof {
  proofBytes: Uint8Array;
  publicInputs: Uint8Array[];
}

/** Raw snarkjs / arkworks proof output. mopro's `generateCircomProof`
 *  returns the same shape (decimal strings) so this type is shared. */
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
}

/** Proof generation result before serialisation. */
export interface ProofResult {
  proof: RawProof;
  publicSignals: string[];
}
