import React, { createContext, use, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppearanceMode, Theme, ThemeName } from './types';
import { getTheme } from './themes';

interface ThemeContextType {
  theme: Theme;
  themeName: ThemeName;
  appearanceMode: AppearanceMode;
  setThemeName: (name: ThemeName) => Promise<void>;
  setAppearanceMode: (mode: AppearanceMode) => Promise<void>;
}

const THEME_NAME_KEY = '@playgrounditor:theme_name';
const APPEARANCE_MODE_KEY = '@playgrounditor:appearance_mode';
const THEME_NAMES: string[] = ['playgrounditor', 'dracula', 'solarized', 'nord', 'github'];

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [themeName, setThemeName] = useState<ThemeName>('playgrounditor');
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>('system');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      try {
        const storedName = await AsyncStorage.getItem(THEME_NAME_KEY);
        const storedMode = await AsyncStorage.getItem(APPEARANCE_MODE_KEY);
        if (storedName && THEME_NAMES.includes(storedName)) {
          setThemeName(storedName as ThemeName);
        }
        if (storedMode && ['system', 'light', 'dark'].includes(storedMode)) {
          setAppearanceMode(storedMode as AppearanceMode);
        }
      } catch (e: unknown) {
        console.warn('Could not load theme settings', e);
      } finally {
        setLoaded(true);
      }
    }
    void loadSettings();
  }, []);

  async function saveThemeName(name: ThemeName) {
    setThemeName(name);
    try {
      await AsyncStorage.setItem(THEME_NAME_KEY, name);
    } catch (e: unknown) {
      console.warn('Could not save theme', e);
    }
  }

  async function saveAppearanceMode(mode: AppearanceMode) {
    setAppearanceMode(mode);
    try {
      await AsyncStorage.setItem(APPEARANCE_MODE_KEY, mode);
    } catch (e: unknown) {
      console.warn('Could not save appearance mode', e);
    }
  }

  const resolvedMode: 'light' | 'dark' =
    appearanceMode === 'system'
      ? systemColorScheme === 'dark'
        ? 'dark'
        : 'light'
      : appearanceMode;

  const theme = getTheme(themeName, resolvedMode);

  if (!loaded) {
    return null;
  }

  return (
    <ThemeContext value={{ theme, themeName, appearanceMode, setThemeName: saveThemeName, setAppearanceMode: saveAppearanceMode }}>
      {children}
    </ThemeContext>
  );
}

export function useTheme(): ThemeContextType {
  const context = use(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
