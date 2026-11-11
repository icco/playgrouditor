import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { errorMessage } from '../lib/errors';
import { Entry, formatDate, isEditable, isMarkdown, newFilePath, sortEntries } from '../lib/github';
import { listDirOffline, repoOffline } from '../lib/offlineFallback';
import { RootStackParamList, SortBy } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'FileBrowser'>;

const MODIFIED_STALE_MS = 10 * 60 * 1000;

export function FileBrowserScreen({ route, navigation }: Props) {
  const { repoFullName, path: currentPath = '' } = route.params;
  const { github } = useAuth();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const queryClient = useQueryClient();
  // Lives in the persisted query cache so every open folder and later session share it.
  const { data: sortBy = 'name' } = useQuery<SortBy>({ queryKey: ['sortBy'], queryFn: skipToken });
  const [modalVisible, setModalVisible] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  const repoQuery = useQuery({
    queryKey: ['repo', repoFullName],
    queryFn: () => repoOffline(github!, repoFullName),
    enabled: !!github,
  });
  const defaultBranch = repoQuery.data?.default_branch;

  const dirQuery = useQuery({
    queryKey: ['dir', repoFullName, currentPath, defaultBranch],
    queryFn: () => listDirOffline(github!, repoFullName, currentPath, defaultBranch!),
    enabled: !!github && !!defaultBranch,
  });

  const paths = useMemo(() => (dirQuery.data ?? []).map(e => e.path), [dirQuery.data]);
  const modifiedQuery = useQuery({
    queryKey: ['modified', repoFullName, currentPath, defaultBranch, paths],
    queryFn: () => github!.modifiedDates(repoFullName, paths, defaultBranch!),
    enabled: isFocused && !!github && !!defaultBranch && sortBy === 'modified' && paths.length > 0,
    staleTime: MODIFIED_STALE_MS,
  });

  const entries = useMemo(() => {
    const dates = sortBy === 'modified' ? modifiedQuery.data : undefined;
    const withDates = (dirQuery.data ?? []).map(e => ({ ...e, modified: dates?.[e.path] }));
    return sortEntries(withDates, sortBy);
  }, [dirQuery.data, modifiedQuery.data, sortBy]);

  const failure = repoQuery.error ?? dirQuery.error ?? (sortBy === 'modified' ? modifiedQuery.error : null);
  const loading = !dirQuery.data && (repoQuery.isLoading || dirQuery.isLoading);
  const breadcrumbs = currentPath ? currentPath.split('/') : [];

  function openDir(path: string) {
    navigation.push('FileBrowser', { repoFullName, path });
  }

  // Each directory level is its own stack entry, so a crumb's distance is its depth difference.
  function popToDepth(depth: number) {
    const count = breadcrumbs.length - depth;
    if (count > 0) navigation.pop(count);
  }

  function handlePress(item: Entry) {
    if (item.type === 'dir') {
      openDir(item.path);
    } else if (item.type !== 'file' || !isEditable(item.name)) {
      Alert.alert('Cannot edit', `${item.name} is not a text file this app can edit.`);
    } else if (defaultBranch) {
      navigation.navigate('Editor', { repoFullName, path: item.path, sha: item.sha, defaultBranch });
    }
  }

  function handleCreateNew() {
    const targetPath = newFilePath(currentPath, newFileName);
    if (!targetPath) {
      Alert.alert('Invalid file name', 'Use a name like post-title.md, without empty, "." or ".." folders.');
      return;
    }
    if (!defaultBranch) {
      Alert.alert('Repository not loaded', 'Connect to the internet and try again.');
      return;
    }
    const existing = entries.find(e => e.path === targetPath && e.type === 'file');
    setModalVisible(false);
    setNewFileName('');
    navigation.navigate('Editor', {
      repoFullName,
      path: targetPath,
      defaultBranch,
      ...(existing ? { sha: existing.sha } : { isNew: true }),
    });
  }

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: theme.colors.background },
        breadcrumbRow: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: 14,
          backgroundColor: theme.colors.surface,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        crumbBtn: { paddingVertical: 2 },
        crumbRoot: { fontSize: 14, fontWeight: '600', color: theme.colors.primary },
        crumbSep: { fontSize: 14, color: theme.colors.placeholder, marginHorizontal: 6 },
        crumbText: { fontSize: 14, color: theme.colors.text },
        list: { padding: 16, paddingBottom: 100 + insets.bottom },
        center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
        empty: { textAlign: 'center', color: theme.colors.textMuted, fontSize: 14, marginTop: 24 },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.colors.surface,
          borderRadius: 10,
          padding: 14,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: theme.colors.borderSubtle,
        },
        rowDir: { borderColor: theme.colors.primaryBorder },
        rowIcon: { fontSize: 18, marginRight: 12 },
        rowText: { fontSize: 16, color: theme.colors.text, flex: 1 },
        rowMd: { fontWeight: '600', color: theme.colors.primary },
        rowInfo: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
        rowDate: { fontSize: 12, color: theme.colors.textMuted, marginLeft: 8 },
        sortRow: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 10,
          backgroundColor: theme.colors.surface,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        sortLabel: { fontSize: 13, color: theme.colors.textMuted, marginRight: 8, fontWeight: '500' },
        sortBtn: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: theme.colors.inputBg,
          marginRight: 6,
        },
        sortBtnActive: { backgroundColor: theme.colors.primary },
        sortBtnText: { fontSize: 13, color: theme.colors.textMuted, fontWeight: '500' },
        sortBtnTextActive: { color: theme.colors.onPrimary },
        fab: {
          position: 'absolute',
          right: 24,
          bottom: 24 + insets.bottom,
          width: 60,
          height: 60,
          borderRadius: 30,
          backgroundColor: theme.colors.primary,
          justifyContent: 'center',
          alignItems: 'center',
          elevation: 6,
        },
        fabText: { fontSize: 28, color: theme.colors.onPrimary, fontWeight: '300', marginTop: -2 },
        modalOverlay: {
          flex: 1,
          backgroundColor: theme.colors.overlay,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 24,
        },
        modalCard: {
          backgroundColor: theme.colors.surface,
          borderRadius: 16,
          padding: 24,
          width: '100%',
          maxWidth: 360,
          elevation: 6,
        },
        modalTitle: { fontSize: 18, fontWeight: '700', color: theme.colors.text, marginBottom: 16 },
        modalInput: {
          backgroundColor: theme.colors.inputBg,
          borderRadius: 10,
          height: 48,
          paddingHorizontal: 16,
          fontSize: 15,
          color: theme.colors.text,
          marginBottom: 20,
        },
        modalButtons: { flexDirection: 'row', justifyContent: 'flex-end' },
        modalBtn: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, marginLeft: 10 },
        modalBtnCancel: { backgroundColor: theme.colors.inputBg },
        modalBtnCancelText: { color: theme.colors.textMuted, fontWeight: '600' },
        modalBtnCreate: { backgroundColor: theme.colors.primary },
        modalBtnCreateText: { color: theme.colors.onPrimary, fontWeight: '600' },
        error: {
          backgroundColor: theme.colors.dangerBg,
          color: theme.colors.dangerText,
          padding: 12,
          margin: 16,
          borderRadius: 8,
          textAlign: 'center',
          fontSize: 14,
        },
      }),
    [theme, insets.bottom],
  );

  return (
    <View style={styles.container}>
      <View style={styles.breadcrumbRow}>
        <Pressable accessibilityRole="button" onPress={() => popToDepth(0)} style={styles.crumbBtn}>
          <Text style={styles.crumbRoot}>{repoFullName}</Text>
        </Pressable>
        {breadcrumbs.map((crumb, idx) => (
          <React.Fragment key={breadcrumbs.slice(0, idx + 1).join('/')}>
            <Text style={styles.crumbSep}>/</Text>
            <Pressable accessibilityRole="button" onPress={() => popToDepth(idx + 1)} style={styles.crumbBtn}>
              <Text style={styles.crumbText}>{crumb}</Text>
            </Pressable>
          </React.Fragment>
        ))}
      </View>

      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>Sort by:</Text>
        {(['name', 'modified'] as const).map(option => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ checked: sortBy === option }}
            style={[styles.sortBtn, sortBy === option && styles.sortBtnActive]}
            onPress={() => queryClient.setQueryData<SortBy>(['sortBy'], option)}
          >
            <Text style={[styles.sortBtnText, sortBy === option && styles.sortBtnTextActive]}>
              {option === 'name' ? 'Name' : 'Modified'}
            </Text>
          </Pressable>
        ))}
      </View>

      {failure ? <Text style={styles.error}>{errorMessage(failure, 'Failed to load directory')}</Text> : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={item => item.path}
          refreshControl={
            <RefreshControl
              refreshing={dirQuery.isRefetching}
              onRefresh={() => {
                void repoQuery.refetch();
                void dirQuery.refetch();
                if (sortBy === 'modified') void modifiedQuery.refetch();
              }}
              tintColor={theme.colors.primary}
            />
          }
          ListEmptyComponent={failure ? undefined : <Text style={styles.empty}>This folder is empty.</Text>}
          renderItem={({ item }) => {
            const isMd = isMarkdown(item.name);
            return (
              <Pressable
                accessibilityRole="button"
                style={[styles.row, item.type === 'dir' && styles.rowDir]}
                onPress={() => handlePress(item)}
              >
                <Text style={styles.rowIcon}>{item.type === 'dir' ? '📁' : isMd ? '📝' : '📄'}</Text>
                <View style={styles.rowInfo}>
                  <Text style={[styles.rowText, isMd && styles.rowMd]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.modified ? <Text style={styles.rowDate}>{formatDate(item.modified)}</Text> : null}
                </View>
              </Pressable>
            );
          }}
          contentContainerStyle={styles.list}
        />
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New file"
        style={styles.fab}
        onPress={() => setModalVisible(true)}
      >
        <Text style={styles.fabText}>＋</Text>
      </Pressable>

      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <KeyboardAvoidingView behavior="padding" style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New File</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g. post-title.md"
              placeholderTextColor={theme.colors.placeholder}
              value={newFileName}
              onChangeText={setNewFileName}
              onSubmitEditing={handleCreateNew}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="File name"
            />
            <View style={styles.modalButtons}>
              <Pressable
                accessibilityRole="button"
                style={[styles.modalBtn, styles.modalBtnCancel]}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.modalBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.modalBtn, styles.modalBtnCreate]}
                onPress={handleCreateNew}
              >
                <Text style={styles.modalBtnCreateText}>Create</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
