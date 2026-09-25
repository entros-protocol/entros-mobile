import { entrosAnchorIdl, entrosRegistryIdl, entrosVerifierIdl } from "../idl";
import { DEFAULT_MIN_DISTANCE, DEFAULT_THRESHOLD } from "../../proof/constants";

interface NamedInstruction {
  name: string;
}

interface NamedType {
  name: string;
  type: { fields?: NamedInstruction[] };
}

interface IdlConstant {
  name: string;
  type: string;
  value: string;
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

  test("keeps mobile defaults equal to the verifier ceiling and floor", () => {
    const constants = new Map(
      (
        entrosVerifierIdl as unknown as {
          constants?: IdlConstant[];
        }
      ).constants?.map((entry) => [entry.name, entry]),
    );
    const readU16 = (name: string): number => {
      const entry = constants.get(name);
      expect(entry).toBeDefined();
      expect(entry?.type).toBe("u16");
      const value = Number(entry?.value);
      expect(Number.isSafeInteger(value)).toBe(true);
      return value;
    };

    expect(DEFAULT_THRESHOLD).toBe(readU16("MAX_THRESHOLD"));
    expect(DEFAULT_MIN_DISTANCE).toBe(readU16("MIN_DISTANCE_FLOOR"));
  });
});
