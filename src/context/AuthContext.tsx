import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Alert, AppState, ToastAndroid } from 'react-native';
import { onlineManager } from '@tanstack/react-query';
import * as Keychain from 'react-native-keychain';
import { flushOutbox, startOutbox, stopOutbox, subscribeOutbox } from '../lib/outbox';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GitHub, User } from '../lib/github';
import { clearLocalFiles, listDrafts } from '../lib/localFiles';
import { persister, queryClient } from '../lib/queryClient';
import { ensureBackgroundSync, setBackgroundSync } from '../lib/backgroundSync';
import { KEYCHAIN_SERVICE } from '../config';

interface AuthContextType {
  token: string | null;
  user: User | null;
  loading: boolean;
  loginWithToken: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  github: GitHub | null;
  recentRepos: string[];
  addRecentRepo: (fullName: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const RECENT_KEY = '@playgrounditor:recent_repos';
const USER_KEY = '@playgrounditor:user';

function parseStored<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e: unknown) {
    console.warn('Ignoring unreadable stored value', e);
    return null;
  }
}

function confirmDraftLoss(count: number, login: string): Promise<boolean> {
  return new Promise(resolve => {
    Alert.alert(
      `Switch to ${login}?`,
      `This deletes ${count} uncommitted draft${count === 1 ? '' : 's'} left by the previous account from this device.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Delete and continue', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: false },
    );
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [recentRepos, setRecentRepos] = useState<string[]>([]);

  const signOutLocally = useCallback(async () => {
    stopOutbox();
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
    setToken(null);
    setUser(null);
  }, []);

  const github = useMemo(() => {
    if (!token) return null;
    const gh = new GitHub(token);
    // Drafts stay on a rejected token so a re-login can still save them.
    gh.onUnauthorized = () => void signOutLocally();
    return gh;
  }, [token, signOutLocally]);

  useEffect(() => {
    async function init() {
      try {
        const [storedRecent, storedUser] = await Promise.all([
          AsyncStorage.getItem(RECENT_KEY),
          AsyncStorage.getItem(USER_KEY),
        ]);
        setRecentRepos(parseStored<string[]>(storedRecent) ?? []);
        setUser(parseStored<User>(storedUser));
        const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
        if (creds) setToken(creds.password);
      } catch (e: unknown) {
        console.error('Failed to restore session', e);
      } finally {
        setLoading(false);
      }
    }
    void init();
  }, []);

  useEffect(() => {
    if (!github) return;
    github
      .user()
      .then(u => {
        setUser(u);
        return AsyncStorage.setItem(USER_KEY, JSON.stringify(u));
      })
      .catch((e: unknown) => console.warn('Could not refresh GitHub user', e));
  }, [github]);

  useEffect(() => {
    if (!github) return;
    startOutbox();
    ensureBackgroundSync().catch((e: unknown) => console.error('Could not schedule offline refresh', e));
    const flush = () => {
      if (!onlineManager.isOnline()) return;
      flushOutbox(github, draft => {
        ToastAndroid.show(`Sent ${draft.path}`, ToastAndroid.SHORT);
        void queryClient.invalidateQueries({ queryKey: ['dir', draft.repoFullName] });
        void queryClient.invalidateQueries({ queryKey: ['modified', draft.repoFullName] });
      }).catch((e: unknown) => console.error('Could not send queued commits', e));
    };
    flush();
    const unsubscribeOnline = onlineManager.subscribe(flush);
    const unsubscribeQueue = subscribeOutbox(flush);
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') flush();
    });
    return () => {
      unsubscribeOnline();
      unsubscribeQueue();
      appState.remove();
    };
  }, [github]);

  const loginWithToken = useCallback(async (t: string) => {
    const u = await new GitHub(t).user();
    // Data kept after a rejected token belongs to that account, and queued commits must not send as another.
    const previous = parseStored<User>(await AsyncStorage.getItem(USER_KEY));
    if (previous && previous.login !== u.login) {
      const drafts = await listDrafts();
      if (drafts.length && !(await confirmDraftLoss(drafts.length, u.login))) {
        throw new Error('Sign in cancelled. Your drafts are still on this device.');
      }
      queryClient.clear();
      setRecentRepos([]);
      await Promise.all([
        persister.removeClient(),
        clearLocalFiles(),
        AsyncStorage.removeItem(RECENT_KEY),
        setBackgroundSync(false),
      ]);
    }
    await Keychain.setGenericPassword('github', t, { service: KEYCHAIN_SERVICE });
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
    setToken(t);
  }, []);

  const logout = useCallback(async () => {
    await signOutLocally();
    queryClient.clear();
    setRecentRepos([]);
    await Promise.all([
      persister.removeClient(),
      clearLocalFiles(),
      AsyncStorage.removeItem(RECENT_KEY),
      AsyncStorage.removeItem(USER_KEY),
      setBackgroundSync(false),
    ]);
  }, [signOutLocally]);

  const addRecentRepo = useCallback(async (fullName: string) => {
    const updated = [fullName, ...recentRepos.filter(r => r !== fullName)].slice(0, 10);
    setRecentRepos(updated);
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  }, [recentRepos]);

  const value = useMemo(
    () => ({ token, user, loading, loginWithToken, logout, github, recentRepos, addRecentRepo }),
    [token, user, loading, loginWithToken, logout, github, recentRepos, addRecentRepo],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
