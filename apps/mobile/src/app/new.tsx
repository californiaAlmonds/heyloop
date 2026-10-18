import { useLocalSearchParams, useRouter, useTheme } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeyLoop } from '@/lib/client';
import { useAction } from '@/lib/use-action';

const DANGER = '#e5484d';

export default function NewChat() {
  const { workspace: preselectedWorkspace, room: preselectedRoom } = useLocalSearchParams<{
    workspace?: string;
    room?: string;
  }>();
  const router = useRouter();
  const { colors } = useTheme();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const snap = useHeyLoop();

  const allWorkspaces = snap.machines.flatMap((m) => {
    const machineReady = m.status === 'online' && m.computerOnline;
    return m.workspaces.map((w) => ({
      key: `${m.room}:${w.id}`,
      room: m.room,
      machineName: m.name,
      id: w.id,
      name: w.name,
      label: `${w.name} — ${m.name}`,
      open: machineReady && Boolean(w.open),
    }));
  });
  const openWorkspaces = allWorkspaces.filter((w) => w.open);
  const sortedWorkspaces = [...allWorkspaces].sort(
    (a, b) =>
      Number(b.open) - Number(a.open) ||
      a.name.localeCompare(b.name) ||
      a.machineName.localeCompare(b.machineName),
  );

  const hasExplicitTarget = Boolean(preselectedRoom || preselectedWorkspace);
  const explicitKey =
    preselectedRoom && preselectedWorkspace ? `${preselectedRoom}:${preselectedWorkspace}` : undefined;

  const [selectedKey, setSelectedKey] = useState<string | undefined>(() => {
    if (explicitKey) return explicitKey;
    if (hasExplicitTarget) return undefined;
    return openWorkspaces.length === 1 ? openWorkspaces[0].key : undefined;
  });
  const userPicked = useRef(false);
  const prevParams = useRef({ room: preselectedRoom, workspace: preselectedWorkspace });
  const [text, setText] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(Keyboard.isVisible());

  useEffect(() => {
    if (prevParams.current.room !== preselectedRoom || prevParams.current.workspace !== preselectedWorkspace) {
      prevParams.current = { room: preselectedRoom, workspace: preselectedWorkspace };
      userPicked.current = false;
      setSelectedKey(explicitKey);
      return;
    }
    if (hasExplicitTarget || userPicked.current || selectedKey !== undefined) return;
    if (openWorkspaces.length === 1) {
      setSelectedKey(openWorkspaces[0].key);
    }
  }, [preselectedRoom, preselectedWorkspace, explicitKey, hasExplicitTarget, selectedKey, openWorkspaces]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const selectedWorkspace = selectedKey ? allWorkspaces.find((w) => w.key === selectedKey) : undefined;
  const separatorIdx = selectedKey ? selectedKey.indexOf(':') : -1;
  const selectedRoom =
    selectedWorkspace?.room ?? (separatorIdx > 0 ? selectedKey?.slice(0, separatorIdx) : preselectedRoom);
  const selectedWorkspaceId =
    selectedWorkspace?.id ?? (separatorIdx > 0 ? selectedKey?.slice(separatorIdx + 1) : preselectedWorkspace);
  const { busy, error, run } = useAction(selectedRoom, selectedWorkspaceId);

  const selectedUnavailableMessage =
    selectedKey && !selectedWorkspace
      ? !snap.loaded
        ? 'Loading target workspace…'
        : 'Selected workspace is unavailable. Pick another workspace to send.'
      : selectedWorkspace && !selectedWorkspace.open
        ? `${selectedWorkspace.label} is offline or closed. Pick another workspace to send.`
        : hasExplicitTarget && !selectedKey
          ? 'Selected workspace is unavailable. Pick another workspace to send.'
          : undefined;

  const body = text.trim();
  const canSend = Boolean(selectedWorkspace?.open) && Boolean(body) && !busy;

  const send = async () => {
    if (!selectedWorkspace?.open || !body || busy) return;
    if (
      await run(
        body,
        { type: 'new_chat', workspace_id: selectedWorkspace.id, text: body },
        selectedWorkspace.room,
        selectedWorkspace.id,
      )
    ) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={headerHeight} style={styles.fill}>
      <ScrollView style={styles.fill} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Workspace</Text>
        {sortedWorkspaces.length === 0 ? (
          <Text style={[styles.empty, { color: colors.text }]}>Open VS Code with the HeyLoop extension</Text>
        ) : (
          <>
            {openWorkspaces.length === 0 && (
              <Text style={[styles.empty, { color: colors.text }]}>
                No workspace is open. Open one in VS Code to start a chat.
              </Text>
            )}
            <View style={styles.list}>
              {sortedWorkspaces.map((workspace) => {
                const isOpen = workspace.open;
                const selected = workspace.key === selectedKey;
                return (
                  <Pressable
                    key={workspace.key}
                    accessibilityRole="button"
                    accessibilityLabel={isOpen ? workspace.label : `${workspace.label}, Closed`}
                    accessibilityState={{ selected, disabled: !isOpen || busy }}
                    disabled={!isOpen || busy}
                    onPress={() => {
                      userPicked.current = true;
                      setSelectedKey(workspace.key);
                    }}
                    style={[
                      styles.item,
                      {
                        backgroundColor: colors.card,
                        borderColor: selected ? colors.primary : colors.border,
                        opacity: isOpen ? 1 : 0.5,
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
                      {workspace.label}
                    </Text>
                    {!isOpen && (
                      <Text style={[styles.closedLabel, { color: colors.text }]}>Closed</Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
      <View style={[styles.composer, { borderColor: colors.border, paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom) }]}>
        {selectedUnavailableMessage && <Text style={styles.error}>{selectedUnavailableMessage}</Text>}
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
  closedLabel: { fontSize: 12, opacity: 0.7 },
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
