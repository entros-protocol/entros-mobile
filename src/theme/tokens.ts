// Visual tokens for entros-mobile. Mobile and web each tune these for their
// own surface — pure black on mobile reads cleaner against the e. logo;
// `#0A0A0F` on web reads cleaner against full-bleed gradient sections.
// Keep accent + Solana brand colors in sync across platforms; treat surface
// and background as platform-tuned.
//
// Typography mirrors entros.io's three-font system:
//   - **Inter** for all body, UI, headings, button labels (regular/medium/
//     semiBold/bold). The brand voice for everything except technical and
//     wordmark slots. Maps to `fontFamily.regular/medium/semiBold/bold`.
//   - **JetBrains Mono** for narrow technical artifacts only — commitment
//     hex displays, addresses, transaction signatures, error codes, dev
//     panel. Maps to `fontFamily.mono` / `fontFamily.monoRegular`. Mirrors
//     the website's reservation of mono for the Solana wallet adapter
//     overrides + technical data — never used as a body font.
//   - **VT323** for the `<EntrosLogo>` wordmark only. Single-weight CRT
//     terminal pixel font. Maps to `fontFamily.wordmark`.
// All three families are loaded once in `app/_layout.tsx` via expo-font.
export type Mode = "dark" | "light";

export interface Palette {
  background: string;
  surface: string;
  surfaceHover: string;
  border: string;
  borderFocus: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  accent: string;
  accentMuted: string;
  solanaPurple: string;
  solanaGreen: string;
  warning: string;
  danger: string;
  glow: string;
  // Premium glassmorphism tokens. Glass cards layer a low-alpha fill on top of
  // a BlurView with a cyan-tinted hairline border. The fill is tuned to keep
  // text legible even when the BlurView falls back to no-blur on lower-end
  // Android. `glassFillStrong` is for the "active / focused" card state.
  glassFill: string;
  glassFillStrong: string;
  glassBorder: string;
  glassBorderStrong: string;
  glassHighlight: string;
  // Ambient background gradient stops, painted via an absolute LinearGradient
  // behind every Screen. Top-left → mid → bottom-right with a barely-there
  // shift toward the cyan accent and Solana purple. Restraint is deliberate —
  // the goal is depth, not chroma.
  gradientStart: string;
  gradientMid: string;
  gradientEnd: string;
  // Cyan radial bloom used by HeroGlow behind hero blocks (welcome wordmark,
  // dashboard score). Higher alpha = more glow.
  heroGlow: string;
}

const dark: Palette = {
  background: "#000000",
  surface: "#0E0E14",
  surfaceHover: "#16161E",
  border: "rgba(255, 255, 255, 0.06)",
  borderFocus: "rgba(34, 211, 230, 0.35)",
  text: "#E8E6E0",
  textMuted: "#858595",
  textSubtle: "#3A3A48",
  accent: "#22D3E6",
  accentMuted: "rgba(34, 211, 230, 0.16)",
  solanaPurple: "#A855F7",
  solanaGreen: "#14F195",
  warning: "#FFB800",
  danger: "#FF3B3B",
  glow: "rgba(34, 211, 230, 0.18)",
  glassFill: "rgba(255, 255, 255, 0.04)",
  glassFillStrong: "rgba(34, 211, 230, 0.06)",
  glassBorder: "rgba(255, 255, 255, 0.08)",
  glassBorderStrong: "rgba(34, 211, 230, 0.32)",
  glassHighlight: "rgba(255, 255, 255, 0.08)",
  gradientStart: "#06080F",
  gradientMid: "#000000",
  gradientEnd: "#0A061A",
  heroGlow: "rgba(34, 211, 230, 0.22)",
};

const light: Palette = {
  background: "#FAFAF8",
  surface: "#F0F0EC",
  surfaceHover: "#E6E6E0",
  border: "rgba(0, 0, 0, 0.08)",
  borderFocus: "rgba(10, 173, 188, 0.4)",
  text: "#1A1A1F",
  textMuted: "#5A5A6A",
  textSubtle: "#B0B0BA",
  accent: "#0AADBC",
  accentMuted: "rgba(10, 173, 188, 0.12)",
  solanaPurple: "#7C3AED",
  solanaGreen: "#059669",
  warning: "#D97706",
  danger: "#DC2626",
  glow: "rgba(10, 173, 188, 0.15)",
  glassFill: "rgba(255, 255, 255, 0.6)",
  glassFillStrong: "rgba(10, 173, 188, 0.06)",
  glassBorder: "rgba(0, 0, 0, 0.06)",
  glassBorderStrong: "rgba(10, 173, 188, 0.32)",
  glassHighlight: "rgba(255, 255, 255, 0.7)",
  gradientStart: "#FAFAF8",
  gradientMid: "#F4F4F0",
  gradientEnd: "#EEF1F4",
  heroGlow: "rgba(10, 173, 188, 0.18)",
};

export const palettes: Record<Mode, Palette> = { dark, light };

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  hero: 48,
  page: 64,
} as const;

export const radii = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  pill: 999,
} as const;

// Brand voice (Inter) + technical voice (JetBrains Mono) + wordmark (VT323).
// All loaded by useFonts in app/_layout.tsx; the keys below must match the
// google-fonts package export names exactly.
export const fontFamily = {
  // Brand voice — body, UI, headings, labels, buttons. Use these for
  // anything that's natural-language copy.
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semiBold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  // Technical voice — commitment hex, addresses, tx sigs, error codes,
  // dev panel. Reach for these only when byte-by-byte alignment matters
  // or the text reads as data, not copy.
  mono: "JetBrainsMono_500Medium",
  monoRegular: "JetBrainsMono_400Regular",
  // Wordmark — `<EntrosLogo>` only. Never used elsewhere.
  wordmark: "VT323_400Regular",
} as const;

export const fontSize = {
  micro: 11,
  caption: 12,
  small: 13,
  body: 15,
  bodyLarge: 17,
  heading: 22,
  title: 28,
  display: 36,
  hero: 48,
} as const;

export const lineHeight = {
  tight: 1.2,
  normal: 1.45,
  relaxed: 1.6,
} as const;
