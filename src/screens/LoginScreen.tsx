import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { startDeviceFlow, pollDeviceFlow, DeviceCode, GitHubError, SLOW_DOWN_PENALTY_MS, isTransient } from '../lib/github';
import { errorMessage } from '../lib/errors';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeContext';

export function LoginScreen() {
  const { loginWithToken } = useAuth();
  const { theme } = useTheme();
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollSessionRef = useRef(0);

  useEffect(() => () => {
    pollSessionRef.current += 1;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  async function handleStartDevice() {
    setLoading(true);
    setError(null);
    try {
      const dc = await startDeviceFlow();
      setDeviceCode(dc);
      startPolling(dc);
    } catch (e: unknown) {
      const msg = e instanceof GitHubError || e instanceof Error ? e.message : 'Failed to start device sign in';
      setError(msg);
      setLoading(false);
    }
  }

  function stopPolling() {
    pollSessionRef.current += 1;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }

  function failDeviceFlow(message: string) {
    stopPolling();
    setDeviceCode(null);
    setLoading(false);
    setError(message);
  }

  function startPolling(dc: DeviceCode) {
    let intervalMs = Math.max(dc.interval || 5, 5) * 1000;
    const expiresAt = Date.now() + dc.expires_in * 1000;

    pollSessionRef.current += 1;
    const session = pollSessionRef.current;

    async function poll() {
      if (Date.now() > expiresAt) {
        failDeviceFlow('Sign in timed out. Try again.');
        return;
      }
      try {
        const res = await pollDeviceFlow(dc.device_code);
        if (session !== pollSessionRef.current) return;
        if ('token' in res) {
          // A device code works once, so polling again after a failure here cannot succeed.
          stopPolling();
          const validating = pollSessionRef.current;
          await loginWithToken(res.token).catch((e: unknown) => {
            if (validating === pollSessionRef.current) failDeviceFlow(errorMessage(e, 'Sign in failed'));
          });
          return;
        }
        if (res.slowDown) intervalMs += SLOW_DOWN_PENALTY_MS;
      } catch (e: unknown) {
        if (session !== pollSessionRef.current) return;
        if (!isTransient(e)) {
          failDeviceFlow(errorMessage(e, 'Sign in failed'));
          return;
        }
        console.warn('Sign in poll failed, retrying', e);
      }
      pollTimerRef.current = setTimeout(() => void poll(), intervalMs);
    }

    pollTimerRef.current = setTimeout(() => void poll(), intervalMs);
  }

  function cancelDeviceFlow() {
    stopPolling();
    setDeviceCode(null);
    setLoading(false);
  }

  async function handleManualLogin() {
    if (!manualToken.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await loginWithToken(manualToken.trim());
    } catch (e: unknown) {
      const msg = e instanceof GitHubError || e instanceof Error ? e.message : 'Invalid personal access token';
      setError(msg);
      setLoading(false);
    }
  }

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
      justifyContent: 'center',
      padding: 24,
    },
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      padding: 28,
      shadowColor: theme.colors.cardShadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 12,
      elevation: 3,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
    },
    title: {
      fontSize: 28,
      fontWeight: '700',
      color: theme.colors.text,
      marginBottom: 6,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 15,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginBottom: 28,
    },
    section: {
      width: '100%',
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: 10,
      height: 50,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 20,
    },
    primaryButtonText: {
      color: theme.colors.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    orText: {
      textAlign: 'center',
      color: theme.colors.placeholder,
      fontSize: 13,
      marginBottom: 16,
    },
    input: {
      backgroundColor: theme.colors.inputBg,
      borderRadius: 10,
      height: 48,
      paddingHorizontal: 16,
      fontSize: 15,
      color: theme.colors.text,
      marginBottom: 12,
    },
    secondaryButton: {
      borderWidth: 1,
      borderColor: theme.colors.primary,
      borderRadius: 10,
      height: 46,
      justifyContent: 'center',
      alignItems: 'center',
    },
    secondaryButtonText: {
      color: theme.colors.primary,
      fontSize: 15,
      fontWeight: '600',
    },
    codeSection: {
      alignItems: 'center',
      paddingVertical: 12,
    },
    instruction: {
      fontSize: 15,
      color: theme.colors.text,
      marginBottom: 8,
      textAlign: 'center',
    },
    link: {
      color: theme.colors.primary,
      fontWeight: '600',
      textDecorationLine: 'underline',
    },
    cancelButton: {
      marginTop: 16,
      padding: 10,
    },
    cancelText: {
      color: theme.colors.textMuted,
      fontSize: 14,
      fontWeight: '600',
    },
    codeBox: {
      backgroundColor: theme.colors.inputBg,
      borderRadius: 12,
      paddingVertical: 16,
      paddingHorizontal: 28,
      marginVertical: 16,
    },
    codeText: {
      fontSize: 32,
      fontWeight: '800',
      color: theme.colors.text,
      letterSpacing: 4,
    },
    waitingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 8,
    },
    waitingText: {
      marginLeft: 10,
      color: theme.colors.textMuted,
      fontSize: 14,
    },
    error: {
      backgroundColor: theme.colors.dangerBg,
      color: theme.colors.dangerText,
      padding: 12,
      borderRadius: 8,
      marginBottom: 16,
      textAlign: 'center',
      fontSize: 14,
    },
  });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Playgrounditor</Text>
        <Text style={styles.subtitle}>Calm mobile markdown editor for GitHub</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!deviceCode ? (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => void handleStartDevice()}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color={theme.colors.onPrimary} />
              ) : (
                <Text style={styles.primaryButtonText}>Sign in with GitHub</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.orText}>— or enter Personal Access Token —</Text>
            <TextInput
              style={styles.input}
              placeholder="ghp_..."
              placeholderTextColor={theme.colors.placeholder}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Personal access token"
              value={manualToken}
              onChangeText={setManualToken}
            />
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => void handleManualLogin()}
              disabled={loading || !manualToken.trim()}
            >
              <Text style={styles.secondaryButtonText}>Connect Token</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.codeSection}>
            <TouchableOpacity onPress={() => void Linking.openURL(deviceCode.verification_uri)}>
              <Text style={[styles.instruction, styles.link]}>1. Open github.com/login/device</Text>
            </TouchableOpacity>
            <Text style={styles.instruction}>2. Enter this code:</Text>
            <View style={styles.codeBox}>
              <Text style={styles.codeText} selectable>{deviceCode.user_code}</Text>
            </View>
            <View style={styles.waitingRow}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text style={styles.waitingText}>Waiting for authorization...</Text>
            </View>
            <TouchableOpacity style={styles.cancelButton} onPress={cancelDeviceFlow}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
