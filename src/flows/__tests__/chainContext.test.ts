import { fetchIdentityState, type OnChainIdentity } from "@/protocol/identity";
import { fetchMigrationRecord } from "@/protocol/migration";

import { readChainContext } from "../chainContext";

jest.mock("@/config", () => ({ getConnection: () => ({}) }));
jest.mock("@/protocol/protocolConfig", () => ({
  fetchProjectionPolicy: async () => ({ current: 1, minimumSupported: 1 }),
}));
jest.mock("@/protocol/identity", () => ({ fetchIdentityState: jest.fn() }));
jest.mock("@/protocol/migration", () => ({ fetchMigrationRecord: jest.fn() }));

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PREVIOUS = "SysvarRent111111111111111111111111111111111";

beforeEach(() => {
  jest
    .mocked(fetchIdentityState)
    .mockReset()
    .mockResolvedValue({ projectionVersion: 1 } as OnChainIdentity);
  jest.mocked(fetchMigrationRecord).mockReset().mockResolvedValue(null);
});

describe("chain context", () => {
  test("reads the migration record with the identity and names the earlier wallet", async () => {
    jest.mocked(fetchMigrationRecord).mockResolvedValue({
      migratedAt: 1,
      migratedSlot: BigInt(2),
      previousWallet: PREVIOUS,
    });
    const result = await readChainContext(WALLET, "verify");
    if (result.kind !== "ok") throw new Error("expected a chain context");
    expect(result.chain.previousWallet).toBe(PREVIOUS);
    const [wallet, , failClosed] = jest.mocked(fetchMigrationRecord).mock.calls[0]!;
    expect(wallet.toBase58()).toBe(WALLET);
    expect(failClosed).toBe(true);
  });

  test("names no earlier wallet without a record", async () => {
    const result = await readChainContext(WALLET, "verify");
    if (result.kind !== "ok") throw new Error("expected a chain context");
    expect(result.chain.previousWallet).toBeNull();
  });

  test("reports a failed record read as unreadable chain state", async () => {
    jest.mocked(fetchMigrationRecord).mockRejectedValue(new Error("rpc down"));
    await expect(readChainContext(WALLET, "verify")).resolves.toEqual({
      kind: "unreadable",
      message: "rpc down",
    });
  });
});
