import { parsePairingLink, type PairingLink } from '@heyloop/protocol/crypto';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useLocalSearchParams, useRouter, useTheme } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { client, useHeyLoop } from '@/lib/client';

export default function Pair() {
  const router = useRouter();
  const { colors } = useTheme();
  const { pairing } = useHeyLoop();
  const params = useLocalSearchParams<{ v?: string; r?: string; s?: string; n?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [candidate, setCandidate] = useState<PairingLink>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const handled = useRef(false);

  const accept = (link: string) => {
    try {
      setCandidate(parsePairingLink(link));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not a HeyLoop pairing code');
    }
  };

  // Opened via a heyloop://pair link; still requires explicit confirmation below.
  useEffect(() => {
    if (!params.s) return;
    const query = Object.entries(params).filter((kv): kv is [string, string] => typeof kv[1] === 'string');
    accept(`heyloop://pair?${new URLSearchParams(query).toString()}`);
  }, [params.v, params.r, params.s, params.n]);

  const onScanned = ({ data }: BarcodeScanningResult) => {
    if (handled.current) return;
    handled.current = true;
    accept(data);
  };

  const reset = () => {
    handled.current = false;
    setCandidate(undefined);
    setError(undefined);
  };

  const confirm = async () => {
    if (!candidate) return;
    setSaving(true);
    try {
      await client.pair(candidate);
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save pairing');
      setSaving(false);
    }
  };

  if (candidate) {
    return (
      <View style={styles.center}>
        <Text style={[styles.heading, { color: colors.text }]}>Pair with “{candidate.name}”?</Text>
        <Text style={[styles.body, { color: colors.text }]}>Relay: {new URL(candidate.relay).host}</Text>
        <Text style={[styles.body, { color: colors.text }]}>
          Only continue if this code is shown by your own computer.
        </Text>
        {pairing && (
          <Text style={[styles.body, { color: colors.text }]}>This replaces the pairing with “{pairing.name}”.</Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={styles.actions}>
          <Pressable style={[styles.button, { borderColor: colors.border }]} onPress={reset} disabled={saving}>
            <Text style={{ color: colors.text }}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary, borderColor: colors.primary }]}
            onPress={confirm}
            disabled={saving}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Pair</Text>}
          </Pressable>
        </View>
      </View>
    );
  }

  if (!permission) return <ActivityIndicator style={styles.center} />;

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={[styles.body, { color: colors.text }]}>
          HeyLoop needs the camera to scan the QR code from `heyloop pair` on your computer.
        </Text>
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary, borderColor: colors.primary }]}
          onPress={requestPermission}
        >
          <Text style={styles.primaryText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView style={styles.fill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} />
      <View style={styles.overlay}>
        <Text style={styles.overlayText}>
          {error ?? 'Run `heyloop pair` on your computer and scan the QR code.'}
        </Text>
        {error && (
          <Pressable onPress={reset} hitSlop={8}>
            <Text style={styles.overlayAction}>Scan again</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  heading: { fontSize: 20, fontWeight: '600' },
  body: { fontSize: 15, opacity: 0.8 },
  error: { color: '#e5484d' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 12 },
  button: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  primaryText: { color: '#fff', fontWeight: '600' },
  overlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 48,
    padding: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.65)',
    gap: 8,
  },
  overlayText: { color: '#fff', fontSize: 15 },
  overlayAction: { color: '#fff', fontWeight: '600' },
});
