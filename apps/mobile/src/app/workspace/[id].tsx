import { Stack, useLocalSearchParams, useRouter, useTheme } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChatRow } from '@/components/ChatRow';
import { useHeyLoop } from '@/lib/client';
import {
  OTHER_WORKSPACE_ID,
  WORKSPACE_COLORS,
  chatWorkspace,
  lastActivity,
  machineName,
  workspaceOpenLabel,
} from '@/lib/format';

export default function WorkspaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const snap = useHeyLoop();
  const router = useRouter();
  const { colors } = useTheme();

  const isOther = id === OTHER_WORKSPACE_ID;
  const workspace = isOther ? undefined : snap.workspaces.find((w) => w.id === id);
  const name = isOther ? 'Other' : (workspace?.name ?? 'Workspace');
  const isOpen = !isOther && snap.status === 'online' && snap.computerOnline && Boolean(workspace?.open);
  const machine = machineName(snap);

  const chats = snap.chats
    .filter((c) => (isOther ? !chatWorkspace(c, snap.workspaces) : c.workspace_id === id))
    .sort((a, b) =>
      lastActivity(b, snap.messages[b.chat_id]).localeCompare(lastActivity(a, snap.messages[a.chat_id])),
    );

  return (
    <View style={styles.fill}>
      <Stack.Screen
        options={{
          title: name,
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New chat"
              disabled={!isOpen}
              onPress={() => router.push({ pathname: '/new', params: { workspace: id } })}
              hitSlop={8}
            >
              <Text style={[styles.headerAction, { color: colors.primary, opacity: isOpen ? 1 : 0.4 }]}>
                New chat
              </Text>
            </Pressable>
          ),
        }}
      />
      {!isOther && (
        <View style={[styles.statusBar, { borderColor: colors.border }]}>
          <View style={[styles.dot, { backgroundColor: WORKSPACE_COLORS[isOpen ? 'open' : 'closed'] }]} />
          <Text style={[styles.statusText, { color: colors.text }]}>
            {workspaceOpenLabel({ open: isOpen })} · {machine}
          </Text>
        </View>
      )}
      {!isOther && !isOpen && (
        <Text style={[styles.hint, { color: colors.text, borderColor: colors.border }]}>
          {`Open ${name} in VS Code to start a new chat`}
        </Text>
      )}
      <FlatList
        data={chats}
        keyExtractor={(c) => c.chat_id}
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.text }]}>No chats in this workspace yet.</Text>
        }
        renderItem={({ item }) => <ChatRow chat={item} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  headerAction: { fontWeight: '600' },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, opacity: 0.8 },
  hint: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 13,
    opacity: 0.75,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 40 },
  empty: { padding: 24, textAlign: 'center', opacity: 0.6 },
});
