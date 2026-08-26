import { entrosAnchorIdl, entrosRegistryIdl, entrosVerifierIdl } from "../idl";

interface NamedInstruction {
  name: string;
}

interface NamedType {
  name: string;
  type: { fields?: NamedInstruction[] };
}

const instructionNames = (idl: unknown): string[] =>
  (idl as { instructions: NamedInstruction[] }).instructions.map(({ name }) => name);

describe("bundled protocol IDLs", () => {
  test("includes every compact and projection-policy instruction used by current programs", () => {
    expect(instructionNames(entrosAnchorIdl)).toContain("update_anchor_compact");
    expect(instructionNames(entrosVerifierIdl)).toContain("verify_proof_compact");
    expect(instructionNames(entrosRegistryIdl)).toContain("set_projection_versions");
  });

  test("includes the projection policy fields in ProtocolConfig", () => {
    const types = (entrosRegistryIdl as unknown as { types: NamedType[] }).types;
    const protocolConfig = types.find(({ name }) => name === "ProtocolConfig");
    const fields = protocolConfig?.type.fields?.map(({ name }) => name);

    expect(fields).toEqual(
      expect.arrayContaining([
        "current_projection_version",
        "minimum_supported_projection_version",
      ]),
    );
  });
});
