import type { WalletKind } from "@/state/types";

/** The wallet a verification signs with. Tracks the MWA token as it rotates. */
export class WalletSession {
  private token: string;

  constructor(
    readonly address: string,
    readonly kind: WalletKind,
    authToken: string,
    private readonly persist: (
      authToken: string,
      address: string,
      kind: WalletKind,
    ) => Promise<boolean>,
    private readonly isCancelled: () => boolean = () => false,
  ) {
    this.token = authToken;
  }

  readonly assertActive = (): void => {
    if (this.isCancelled()) throw new Error("Verification was cancelled.");
  };

  get authToken(): string {
    return this.token;
  }

  /** Adopts a token an MWA call returned after `acceptRotated` stored it. */
  adopt(authToken: string): void {
    this.token = authToken;
  }

  /** Stores a rotated token. Throws when the connected wallet changed. */
  readonly acceptRotated = async (authToken: string): Promise<void> => {
    if (this.isCancelled()) throw new Error("Verification was cancelled.");
    const accepted = await this.persist(authToken, this.address, this.kind);
    if (!accepted || this.isCancelled()) {
      throw new Error("The connected wallet changed during signing.");
    }
    this.token = authToken;
  };
}
