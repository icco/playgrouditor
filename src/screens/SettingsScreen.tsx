import React from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../lib/errors';
import { listDrafts } from '../lib/localFiles';
import { refreshOffline, turnOffOffline } from '../lib/offlineActions';
import { formatBytes, offlineStatus } from '../lib/offlineStatus';
import { useKeptRepos } from '../lib/useKeptRepos';
import { useTheme } from '../theme/ThemeContext';
import { ThemeName, AppearanceMode } from '../theme/types';
import { version } from '../../package.json';

const THEME_OPTIONS: Array<{ key: ThemeName; label: string; swatch: string }> = [
  { key: 'playgrounditor', label: 'Playgrounditor', swatch: '#3A5A40' },
  { key: 'dracula', label: 'Dracula', swatch: '#bd93f9' },
  { key: 'solarized', label: 'Solarized', swatch: '#2aa198' },
  { key: 'nord', label: 'Nord', swatch: '#88c0d0' },
  { key: 'github', label: 'GitHub', swatch: '#0969da' },
];

const MODE_OPTIONS: Array<{ key: AppearanceMode; label: string }> = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

export function SettingsScreen() {
  const { user, logout, github } = useAuth();
  const { theme, themeName, appearanceMode, setThemeName, setAppearanceMode } = useTheme();
  const keptRepos = useKeptRepos();

  function confirmRemove(fullName: string) {
    Alert.alert('Remove offline copy?', `${fullName} will only open with a connection. Drafts are kept.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          turnOffOffline(fullName).catch((e: unknown) =>
            Alert.alert('Remove failed', errorMessage(e, 'Could not remove the offline copy')),
          );
        },
      },
    ]);
  }

  async function confirmLogout() {
    const drafts = await listDrafts();
    const warning = drafts.length
      ? `This deletes ${drafts.length} uncommitted draft${drafts.length === 1 ? '' : 's'} and all saved files from this device.`
      : 'This removes saved repositories and files from this device.';
    Alert.alert('Sign out?', warning, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          logout().catch((e: unknown) => Alert.alert('Sign out failed', errorMessage(e, 'Could not clear this device')));
        },
      },
    ]);
  }

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
      padding: 16,
    },
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      padding: 20,
      marginBottom: 16,
      shadowColor: theme.colors.cardShadow,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 4,
      elevation: 2,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 6,
    },
    username: {
      fontSize: 22,
      fontWeight: '700',
      color: theme.colors.text,
      marginBottom: 4,
    },
    name: {
      fontSize: 15,
      color: theme.colors.textMuted,
      marginBottom: 16,
    },
    logoutBtn: {
      backgroundColor: theme.colors.dangerBg,
      borderRadius: 10,
      height: 44,
      justifyContent: 'center',
      alignItems: 'center',
    },
    logoutText: {
      color: theme.colors.dangerText,
      fontSize: 15,
      fontWeight: '600',
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.text,
      marginBottom: 12,
    },
    rowWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    optionBtn: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.inputBg,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 8,
    },
    optionActive: {
      backgroundColor: theme.colors.primaryBg,
      borderColor: theme.colors.primary,
    },
    swatch: {
      width: 14,
      height: 14,
      borderRadius: 7,
      marginRight: 8,
    },
    optionText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    optionTextActive: {
      color: theme.colors.primary,
    },
    offlineRepo: {
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: theme.colors.borderSubtle,
    },
    aboutTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.text,
      marginBottom: 8,
    },
    aboutText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginBottom: 4,
    },
  });

  return (
    <ScrollView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.label}>Signed in as</Text>
        <Text style={styles.username}>@{user?.login || 'unknown'}</Text>
        {user?.name ? <Text style={styles.name}>{user.name}</Text> : null}

        <TouchableOpacity style={styles.logoutBtn} onPress={confirmLogout}>
          <Text style={styles.logoutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Appearance</Text>
        <Text style={styles.label}>Mode</Text>
        <View style={styles.rowWrap}>
          {MODE_OPTIONS.map(m => {
            const active = appearanceMode === m.key;
            return (
              <TouchableOpacity
                key={m.key}
                style={[styles.optionBtn, active && styles.optionActive]}
                onPress={() => void setAppearanceMode(m.key)}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
              >
                <Text style={[styles.optionText, active && styles.optionTextActive]}>{m.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={[styles.label, { marginTop: 12 }]}>Theme</Text>
        <View style={styles.rowWrap}>
          {THEME_OPTIONS.map(t => {
            const active = themeName === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                style={[styles.optionBtn, active && styles.optionActive]}
                onPress={() => void setThemeName(t.key)}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
              >
                <View style={[styles.swatch, { backgroundColor: t.swatch }]} />
                <Text style={[styles.optionText, active && styles.optionTextActive]}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Offline repos</Text>
        {keptRepos.length === 0 ? (
          <Text style={styles.aboutText}>Turn on Keep offline in a repo to read and edit all its files without a connection.</Text>
        ) : null}
        {keptRepos.map(r => (
          <View key={r.fullName} style={styles.offlineRepo}>
            <Text style={styles.optionText}>{r.fullName}</Text>
            <Text style={styles.aboutText}>
              {r.fileCount} files, {formatBytes(r.bytes)}
            </Text>
            <Text style={styles.aboutText}>{offlineStatus(r)}</Text>
            <View style={styles.rowWrap}>
              <TouchableOpacity
                style={styles.optionBtn}
                disabled={!github || r.syncing}
                onPress={() => github && refreshOffline(github, r.fullName)}
              >
                <Text style={styles.optionText}>Refresh now</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.optionBtn} onPress={() => confirmRemove(r.fullName)}>
                <Text style={[styles.optionText, { color: theme.colors.dangerText }]}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.aboutTitle}>Playgrounditor v{version}</Text>
        <Text style={styles.aboutText}>Minimal mobile markdown editor for GitHub.</Text>
      </View>
    </ScrollView>
  );
}
