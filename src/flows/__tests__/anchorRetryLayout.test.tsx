import { act, type ReactNode } from "react";
import { createRoot } from "test-renderer";
import VerifyLayout from "../../../app/verify/_layout";
import { AppStateProvider, useAppState } from "../../state/AppState";

jest.mock("expo-router", () => ({
  Stack: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Screen: () => null,
  }),
}));
jest.mock("@/theme/ThemeProvider", () => ({ useTheme: () => ({ palette: {} }) }));
jest.mock("@/config", () => ({ config: { programs: {} }, getConnection: jest.fn() }));
jest.mock("@/identity/baseline", () => ({ wipeBaseline: jest.fn() }));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));
jest.mock("@/protocol/identity", () => ({
  fetchIdentityState: jest.fn(),
  toAppStateIdentity: jest.fn(),
}));
jest.mock("@/wallet/mwa", () => ({ connect: jest.fn(), disconnect: jest.fn() }));
jest.mock("@/storage/secure", () => ({
  SecureKeys: {},
  getSecure: async () => null,
  setSecure: jest.fn(),
  deleteSecure: jest.fn(),
}));

test("retains quality retries during the flow and clears them when navigation dismisses it", async () => {
  let context: ReturnType<typeof useAppState> | null = null;
  const Consumer = () => {
    context = useAppState();
    return null;
  };
  const tree = createRoot();
  await act(async () =>
    tree.render(
      <AppStateProvider>
        <VerifyLayout />
        <Consumer />
      </AppStateProvider>,
    ),
  );
  await act(async () => context!.setFlowIntent("reset"));
  expect(context!.recordAnchorRetry()).toBe(2);
  expect(context!.recordAnchorRetry()).toBe(1);
  await act(async () => context!.openWalletMenu());
  expect(context!.flow.intent).toBe("reset");
  expect(context!.recordAnchorRetry()).toBe(0);
  await act(async () =>
    tree.render(
      <AppStateProvider>
        <Consumer />
      </AppStateProvider>,
    ),
  );
  expect(context!.flow.intent).toBe("verify");
  expect(context!.recordAnchorRetry()).toBe(2);
  await act(async () => tree.unmount());
});
