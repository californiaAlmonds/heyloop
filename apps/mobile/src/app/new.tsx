import { useRouter, useTheme } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeyLoop } from '@/lib/client';
import { useAction } from '@/lib/use-action';

const DANGER = '#e5484d';

export default function NewChat() {
  const router = useRouter();
  const { colors } = useTheme();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const snap = useHeyLoop();
  const { busy, error, run } = useAction();
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    snap.workspaces.length === 1 ? snap.workspaces[0].id : undefined,
  );
  const [text, setText] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(Keyboard.isVisible());

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const workspaceId = snap.workspaces.some((w) => w.id === selectedId)
    ? selectedId
    : snap.workspaces.length === 1
      ? snap.workspaces[0].id
      : undefined;

  const body = text.trim();
  const canSend = snap.status === 'online' && snap.computerOnline && Boolean(workspaceId) && Boolean(body) && !busy;

  const send = async () => {
    if (!workspaceId || !body || busy) return;
    if (await run(`${workspaceId}:${body}`, { type: 'new_chat', workspace_id: workspaceId, text: body })) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={headerHeight} style={styles.fill}>
      <ScrollView style={styles.fill} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.sectionTitle, { color: colors.text }]}>VS Code window</Text>
        {snap.workspaces.length === 0 ? (
          <Text style={[styles.empty, { color: colors.text }]}>Open VS Code with the HeyLoop extension</Text>
        ) : (
          <View style={styles.list}>
            {snap.workspaces.map((workspace) => {
              const selected = workspace.id === workspaceId;
              return (
                <Pressable
                  key={workspace.id}
                  accessibilityRole="button"
                  accessibilityLabel={workspace.name}
                  accessibilityState={{ selected }}
                  disabled={busy}
                  onPress={() => setSelectedId(workspace.id)}
                  style={[
                    styles.item,
                    {
                      backgroundColor: colors.card,
                      borderColor: selected ? colors.primary : colors.border,
                    },
                    selected && styles.itemSelected,
                  ]}
                >
                  <View
                    style={[
                      styles.radio,
                      { borderColor: selected ? colors.primary : colors.border },
                      selected && { backgroundColor: colors.primary },
                    ]}
                  />
                  <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>
                    {workspace.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
      <View style={[styles.composer, { borderColor: colors.border, paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom) }]}>
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={styles.row}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="What should the agent work on?"
            placeholderTextColor={colors.border}
            multiline
            maxLength={4000}
            editable={!busy}
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send prompt"
            disabled={!canSend}
            onPress={() => void send()}
            style={[styles.send, { backgroundColor: colors.primary, opacity: canSend ? 1 : 0.4 }]}
          >
            <Text style={styles.sendText}>{busy ? '…' : error ? 'Retry' : 'Send'}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 16, gap: 10 },
  sectionTitle: { fontSize: 13, fontWeight: '600', opacity: 0.7 },
  empty: { fontSize: 14, opacity: 0.6, paddingVertical: 8 },
  list: { gap: 8 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  itemSelected: { borderWidth: 2, paddingHorizontal: 13, paddingVertical: 11 },
  radio: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  itemName: { flex: 1, fontSize: 15, fontWeight: '600' },
  composer: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 40,
    maxHeight: 120,
  },
  send: { paddingHorizontal: 16, height: 40, borderRadius: 20, justifyContent: 'center' },
  sendText: { color: '#fff', fontWeight: '600' },
  error: { color: DANGER, fontSize: 13 },
});
