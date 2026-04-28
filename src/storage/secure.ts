import * as SecureStore from "expo-secure-store";

// Hardware-backed on Android (Keystore) and iOS (Keychain). Items are bound to
// this device and this app sandbox; they never sync to iCloud / Google Drive.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

const NAMESPACE = "entros.v1";
const namespaced = (key: string): string => `${NAMESPACE}.${key}`;

export const setSecure = async (key: string, value: string): Promise<void> => {
  await SecureStore.setItemAsync(namespaced(key), value, OPTIONS);
};

export const getSecure = async (key: string): Promise<string | null> => {
  return SecureStore.getItemAsync(namespaced(key), OPTIONS);
};

export const deleteSecure = async (key: string): Promise<void> => {
  await SecureStore.deleteItemAsync(namespaced(key), OPTIONS);
};

export const SecureKeys = {
  WALLET_AUTH_TOKEN: "wallet.auth_token",
  WALLET_ADDRESS: "wallet.address",
  WALLET_LABEL: "wallet.label",
  WALLET_KIND: "wallet.kind",
  // Stage 5 baseline persistence. Envelope holds {v, iv, ct} JSON of the
  // AES-256-GCM-encrypted StoredBaseline. The AES key bytes live separately
  // under their own secure-store entry — both must be present to decrypt.
  // See src/identity/baseline.ts.
  BASELINE_ENVELOPE: "baseline.envelope",
  BASELINE_KEY: "baseline.key",
} as const;

export type SecureKey = (typeof SecureKeys)[keyof typeof SecureKeys];
