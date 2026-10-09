import { act, type ReactNode } from "react";
import { createRoot } from "test-renderer";
import Failure from "../../../app/verify/failure";

let mockParams: Record<string, string>;
const mockReplace = jest.fn();
const mockDismiss = jest.fn();
const mockClear = jest.fn();
const mockIntent = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, dismissAll: mockDismiss }),
}));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("react-native", () => ({
  StyleSheet: { create: (value: unknown) => value },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/icons", () => ({ AlertIcon: () => null, RefreshIcon: () => null }));
jest.mock("@/components/primitives/Screen", () => ({
  Screen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/primitives/Text", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
jest.mock("@/components/primitives/SectionLabel", () => ({
  SectionLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
jest.mock("@/components/primitives/Countdown", () => ({ Countdown: () => null }));
jest.mock("@/components/primitives/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
jest.mock("@/theme/ThemeProvider", () => ({ useTheme: () => ({ palette: {} }) }));
jest.mock("@/state/AppState", () => ({
  useAppState: () => ({ clearAnchorRetries: mockClear, setFlowIntent: mockIntent }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { bucket: "soft", reason: "anchor_retry", attemptsRemaining: "2" };
});

test("a quality retry keeps reset intent, while Cancel clears it", async () => {
  const tree = createRoot();
  await act(async () => tree.render(<Failure />));
  expect(JSON.stringify(tree.container.children)).toContain("We couldn’t read that capture.");
  const retry = tree.container.queryAll(
    (node) => node.type === "button" && node.children.includes("Try again"),
  )[0]!;
  await act(async () => retry.props.onClick());
  expect(mockReplace).toHaveBeenCalledWith("/verify/intro");
  expect(mockIntent).not.toHaveBeenCalled();
  expect(mockClear).not.toHaveBeenCalled();
  const cancel = tree.container.queryAll(
    (node) => node.type === "button" && node.children.includes("Cancel"),
  )[0]!;
  await act(async () => cancel.props.onClick());
  expect(mockIntent).toHaveBeenCalledWith("verify");
  expect(mockClear).toHaveBeenCalledTimes(1);
  expect(mockDismiss).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test.each(["0", "NaN"])(
  "exhausted quality retries offer microphone guidance and an exit (%s)",
  async (remaining) => {
    mockParams.attemptsRemaining = remaining;
    const tree = createRoot();
    await act(async () => tree.render(<Failure />));
    const buttons = tree.container.queryAll((node) => node.type === "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.children).toEqual(["OK"]);
    expect(JSON.stringify(tree.container.children)).toContain("Check your microphone");
    await act(async () => buttons[0]!.props.onClick());
    expect(mockIntent).toHaveBeenCalledWith("verify");
    expect(mockClear).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  },
);

test("paired-required asks for an update without offering an immediate retry", async () => {
  mockParams = { bucket: "session-error", reason: "paired_required" };
  const tree = createRoot();
  await act(async () => tree.render(<Failure />));
  expect(JSON.stringify(tree.container.children)).toContain("Update Entros");
  const buttons = tree.container.queryAll((node) => node.type === "button");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.children).toEqual(["OK"]);
  await act(async () => tree.unmount());
});
