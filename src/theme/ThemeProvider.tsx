import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";

import { Mode, Palette, palettes } from "./tokens";

export type ThemePreference = "system" | "dark" | "light";

interface ThemeContextValue {
  mode: Mode;
  preference: ThemePreference;
  palette: Palette;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "entros.theme.preference";

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("dark");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (value === "system" || value === "dark" || value === "light") {
          setPreferenceState(value);
        }
      })
      .catch(() => undefined);
  }, []);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    AsyncStorage.setItem(STORAGE_KEY, pref).catch(() => undefined);
  }, []);

  const mode: Mode = useMemo(() => {
    if (preference === "system") return system === "light" ? "light" : "dark";
    return preference;
  }, [preference, system]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, preference, palette: palettes[mode], setPreference }),
    [mode, preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return ctx;
};
