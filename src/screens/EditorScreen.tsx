import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { usePreventRemove } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { Repo, isConflict, isMarkdown, isTransient } from '../lib/github';
import { clearOpenFile, notifyOutbox, queueCommit, setOpenFile } from '../lib/outbox';
import { resolveEditorStart } from '../lib/editorStart';
import { cacheFile, deleteDraft, getCachedFile, getDraft, saveDraft } from '../lib/localFiles';
import { errorMessage } from '../lib/errors';
import { queryClient, useIsOnline } from '../lib/queryClient';
import { CodeMirrorEditor } from '../components/CodeMirrorEditor';
import { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Editor'>;
type SaveMode = 'direct' | 'pr';

const DRAFT_DEBOUNCE_MS = 800;

export function EditorScreen({ route, navigation }: Props) {
  const { repoFullName, path, sha: initialSha, defaultBranch, isNew } = route.params;
  const { github } = useAuth();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const online = useIsOnline();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [sha, setSha] = useState(initialSha);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const [commitMsg, setCommitMsg] = useState(`docs: update ${path}`);
  const [editorRevision, setEditorRevision] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const markdown = isMarkdown(path);
  const dirty = !loading && !loadError && text !== savedText;

  const latest = useRef({ text, savedText, sha, dirty });
  latest.current = { text, savedText, sha, dirty };
  const leavingWithoutDraft = useRef(false);

  const persistDraft = useCallback(async () => {
    const current = latest.current;
    if (leavingWithoutDraft.current) return;
    if (current.text === current.savedText) {
      await deleteDraft(repoFullName, path);
    } else {
      await saveDraft({ repoFullName, path, defaultBranch, text: current.text, baseSha: current.sha });
    }
  }, [repoFullName, path, defaultBranch]);

  const persistDraftLogged = useCallback(() => {
    persistDraft().catch((e: unknown) => console.error('Could not save draft', e));
  }, [persistDraft]);

  useEffect(() => {
    if (loading || loadError) return;
    const timer = setTimeout(persistDraftLogged, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, savedText, loading, loadError, persistDraftLogged]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active' && latest.current.dirty) persistDraftLogged();
    });
    return () => {
      sub.remove();
    };
  }, [persistDraftLogged]);

  useEffect(() => {
    setOpenFile(repoFullName, path);
    return () => {
      clearOpenFile();
      const saved = latest.current.dirty ? persistDraft() : Promise.resolve();
      saved
        .catch((e: unknown) => console.error('Could not save draft', e))
        .finally(notifyOutbox);
    };
  }, [repoFullName, path, persistDraft]);

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert('Leave this file?', 'Your edits have not been committed.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          leavingWithoutDraft.current = true;
          deleteDraft(repoFullName, path)
            .catch((e: unknown) => console.error('Could not delete draft', e))
            .finally(() => navigation.dispatch(data.action));
        },
      },
      {
        text: 'Keep draft',
        onPress: () => {
          persistDraft()
            .then(() => navigation.dispatch(data.action))
            .catch((e: unknown) => Alert.alert('Could not save draft', errorMessage(e, 'Your edits are still open here.')));
        },
      },
    ]);
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setLoadError(null);
      setNotice(null);
      try {
        const [draft, cached] = await Promise.all([
          getDraft(repoFullName, path),
          isNew ? null : getCachedFile(repoFullName, path),
        ]);
        if (!active) return;

        let base = cached;
        let fetchError: unknown = null;
        if (!isNew && github) {
          try {
            const file = await github.read(repoFullName, path, defaultBranch);
            base = { sha: file.sha, text: file.text };
            cacheFile(repoFullName, path, base).catch((e: unknown) => console.warn('Could not cache file', e));
          } catch (e: unknown) {
            fetchError = e;
          }
          if (!active) return;
        }

        const start = resolveEditorStart(draft, base, fetchError);
        if ('error' in start) {
          setLoadError(start.error);
          return;
        }
        setSavedText(start.savedText);
        setText(start.text);
        setSha(start.sha);
        setRestoredDraft(start.restoredDraft);
        setNotice(start.notice);
        setEditorRevision(r => r + 1);
      } catch (e: unknown) {
        if (active) setLoadError(errorMessage(e, 'Failed to read file'));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [repoFullName, path, defaultBranch, github, isNew, loadAttempt]);

  async function discardDraft() {
    await deleteDraft(repoFullName, path);
    setText(savedText);
    setRestoredDraft(false);
    setNotice(null);
    setLoadAttempt(a => a + 1);
  }

  useEffect(() => {
    navigation.setOptions({ headerShown: !landscape });
  }, [navigation, landscape]);

  const wordCount = useMemo(() => {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [text]);

  function finishSave(committed: string, prUrl?: string) {
    const buttons = prUrl
      ? [
          { text: 'View pull request', onPress: () => void Linking.openURL(prUrl) },
          { text: 'Done', onPress: () => navigation.goBack() },
        ]
      : [{ text: 'OK', onPress: () => navigation.goBack() }];
    Alert.alert(
      prUrl ? 'Pull request opened' : 'Committed',
      prUrl ?? `Changes committed directly to ${defaultBranch}.`,
      buttons,
    );
    deleteDraft(repoFullName, path).catch((e: unknown) => console.error('Could not delete draft', e));
    void queryClient.invalidateQueries({ queryKey: ['dir', repoFullName] });
    void queryClient.invalidateQueries({ queryKey: ['modified', repoFullName] });
    setSavedText(committed);
    setRestoredDraft(false);
    setNotice(null);
  }

  async function queueSave(mode: SaveMode, committed: string, baseSha?: string) {
    leavingWithoutDraft.current = true;
    await queueCommit({
      repoFullName,
      path,
      defaultBranch,
      text: committed,
      baseSha,
      queued: { mode, message: commitMsg.trim() || `docs: update ${path}` },
    });
    setSavedText(committed);
    Alert.alert('Queued', 'This commit will be sent when you are back online.', [
      { text: 'OK', onPress: () => navigation.goBack() },
    ]);
  }

  async function handleSave(mode: SaveMode, shaOverride?: string) {
    const committed = latest.current.text;
    const baseSha = shaOverride ?? sha;
    setSaving(true);
    setSaveDialog(false);
    if (!github || !online) {
      try {
        await queueSave(mode, committed, baseSha);
      } catch (e: unknown) {
        leavingWithoutDraft.current = false;
        Alert.alert('Could not queue commit', errorMessage(e, 'Could not save on this device'));
      } finally {
        setSaving(false);
      }
      return;
    }
    try {
      const repo = {
        full_name: repoFullName,
        default_branch: defaultBranch,
      } as Repo;
      const res = await github.commit({
        repo,
        path,
        text: committed,
        sha: baseSha,
        message: commitMsg.trim() || `docs: update ${path}`,
        mode,
      });
      if (mode === 'direct') {
        setSha(res.sha);
        cacheFile(repoFullName, path, { sha: res.sha, text: committed }).catch((e: unknown) =>
          console.warn('Could not cache file', e),
        );
      }
      finishSave(committed, res.prUrl);
    } catch (e: unknown) {
      if (!isTransient(e)) persistDraftLogged();
      if (isTransient(e)) {
        await queueSave(mode, committed, baseSha).catch((err: unknown) => {
          leavingWithoutDraft.current = false;
          Alert.alert('Could not queue commit', errorMessage(err, 'Could not save on this device'));
        });
      } else if (isConflict(e, !!baseSha)) {
        Alert.alert('File changed on GitHub', 'Someone else updated this file. Overwrite their version with yours?', [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Overwrite',
            style: 'destructive',
            onPress: () => {
              github
                .read(repoFullName, path, defaultBranch)
                .then(file => handleSave(mode, file.sha))
                .catch((err: unknown) => Alert.alert('Commit failed', errorMessage(err, 'Could not read the latest version')));
            },
          },
        ]);
      } else {
        Alert.alert('Commit failed', `${errorMessage(e, 'Commit failed')}\n\nYour edits are saved on this device.`);
      }
    } finally {
      setSaving(false);
    }
  }

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: theme.colors.background },
        topBar: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: theme.colors.surface,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        topBarCompact: {
          paddingVertical: 4,
          paddingLeft: 8 + insets.left,
          paddingRight: 8 + insets.right,
        },
        backBtn: { paddingHorizontal: 8, paddingVertical: 2, marginRight: 4 },
        backText: { fontSize: 20, color: theme.colors.text },
        fileName: { fontSize: 14, fontWeight: '600', color: theme.colors.text, flex: 1, marginRight: 12 },
        compactStatus: { fontSize: 12, color: theme.colors.textMuted, marginRight: 12 },
        topRight: { flexDirection: 'row', alignItems: 'center' },
        toggleBtn: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          marginRight: 8,
        },
        toggleBtnActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
        toggleText: { fontSize: 13, fontWeight: '600', color: theme.colors.textMuted },
        toggleTextActive: { color: theme.colors.onPrimary },
        saveBtn: {
          backgroundColor: theme.colors.primary,
          paddingHorizontal: 16,
          paddingVertical: 7,
          borderRadius: 6,
          minWidth: 64,
          alignItems: 'center',
        },
        saveBtnText: { fontSize: 13, fontWeight: '600', color: theme.colors.onPrimary },
        saveBtnDisabled: { opacity: 0.5 },
        banner: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: theme.colors.primaryBg,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.primaryBorder,
        },
        bannerText: { flex: 1, fontSize: 13, color: theme.colors.text },
        bannerAction: { fontSize: 13, fontWeight: '600', color: theme.colors.primary, marginLeft: 12 },
        statusBar: {
          paddingTop: 8,
          paddingBottom: 8 + insets.bottom,
          paddingHorizontal: 16,
          backgroundColor: theme.colors.surface,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          flexDirection: 'row',
          justifyContent: 'space-between',
        },
        statusText: { fontSize: 12, color: theme.colors.textMuted },
        center: {
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 24,
          backgroundColor: theme.colors.background,
        },
        errorText: { fontSize: 15, color: theme.colors.text, textAlign: 'center', marginBottom: 16 },
        retry: { fontSize: 15, fontWeight: '600', color: theme.colors.primary },
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
          borderWidth: 1,
          borderColor: theme.colors.borderSubtle,
        },
        modalTitle: { fontSize: 18, fontWeight: '700', color: theme.colors.text, marginBottom: 16 },
        modalLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.textMuted, marginBottom: 6 },
        modalInput: {
          backgroundColor: theme.colors.inputBg,
          borderRadius: 10,
          height: 44,
          paddingHorizontal: 14,
          fontSize: 14,
          color: theme.colors.text,
          marginBottom: 16,
        },
        modalOption: {
          backgroundColor: theme.colors.primaryBg,
          borderRadius: 10,
          padding: 14,
          marginBottom: 10,
          borderWidth: 1,
          borderColor: theme.colors.primaryBorder,
        },
        modalOptionDirect: { backgroundColor: theme.colors.inputBg, borderColor: theme.colors.border },
        modalOptionTitle: { fontSize: 15, fontWeight: '600', color: theme.colors.primary, marginBottom: 2 },
        modalOptionDesc: { fontSize: 13, color: theme.colors.textMuted },
        modalCancel: { marginTop: 8, alignItems: 'center', padding: 10 },
        modalCancelText: { fontSize: 14, fontWeight: '600', color: theme.colors.textMuted },
      }),
    [theme, insets.bottom, insets.left, insets.right],
  );

  const saveDisabled = saving || loading || !!loadError || (!dirty && !isNew);

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.container}>
      <StatusBar hidden={landscape} />
      <View style={[styles.topBar, landscape && styles.topBarCompact]}>
        {landscape ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.backBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backText}>←</Text>
          </Pressable>
        ) : null}
        <Text style={styles.fileName} numberOfLines={1}>
          {path}
        </Text>
        <View style={styles.topRight}>
          {landscape ? (
            <Text style={styles.compactStatus} numberOfLines={1}>
              {online ? '' : 'Offline • '}
              {wordCount} words
            </Text>
          ) : null}
          {markdown ? (
            <Pressable
              accessibilityRole="button"
              style={[styles.toggleBtn, preview && styles.toggleBtnActive]}
              onPress={() => setPreview(p => !p)}
            >
              <Text style={[styles.toggleText, preview && styles.toggleTextActive]}>
                {preview ? 'Edit' : 'Preview'}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: saveDisabled }}
            style={[styles.saveBtn, saveDisabled && styles.saveBtnDisabled]}
            onPress={() => setSaveDialog(true)}
            disabled={saveDisabled}
          >
            {saving ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.saveBtnText}>Save</Text>
            )}
          </Pressable>
        </View>
      </View>

      {restoredDraft ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Restored your unsaved draft.</Text>
          <Pressable accessibilityRole="button" onPress={() => void discardDraft()}>
            <Text style={styles.bannerAction}>Discard</Text>
          </Pressable>
        </View>
      ) : null}
      {notice ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{notice}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{loadError}</Text>
          <Pressable accessibilityRole="button" onPress={() => setLoadAttempt(a => a + 1)}>
            <Text style={styles.retry}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <CodeMirrorEditor
          key={editorRevision}
          initialValue={text}
          onChangeText={setText}
          path={path}
          preview={preview}
        />
      )}

      {landscape ? null : (
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>
            {online ? (dirty ? 'Draft saved on this device' : '') : 'Offline. Edits stay on this device.'}
          </Text>
          <Text style={styles.statusText}>
            {wordCount} words • {text.length} chars
          </Text>
        </View>
      )}

      <Modal visible={saveDialog} transparent animationType="fade" onRequestClose={() => setSaveDialog(false)}>
        <KeyboardAvoidingView behavior="padding" style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{online ? 'Save Changes' : 'Queue for when online'}</Text>
            <Text style={styles.modalLabel}>Commit message</Text>
            <TextInput
              style={styles.modalInput}
              value={commitMsg}
              onChangeText={setCommitMsg}
              placeholder="docs: update..."
              placeholderTextColor={theme.colors.placeholder}
              accessibilityLabel="Commit message"
            />
            <Pressable accessibilityRole="button" style={styles.modalOption} onPress={() => void handleSave('pr')}>
              <Text style={styles.modalOptionTitle}>Open Pull Request</Text>
              <Text style={styles.modalOptionDesc}>Commit to a new branch & open PR</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.modalOption, styles.modalOptionDirect]}
              onPress={() => void handleSave('direct')}
            >
              <Text style={styles.modalOptionTitle}>Commit to {defaultBranch}</Text>
              <Text style={styles.modalOptionDesc}>Push directly to {defaultBranch}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.modalCancel} onPress={() => setSaveDialog(false)}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}
