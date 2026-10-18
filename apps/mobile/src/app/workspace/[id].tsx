import { Stack, useLocalSearchParams, useRouter, useTheme } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChatRow } from '@/components/ChatRow';
import { chatKey, useHeyLoop } from '@/lib/client';
import {
  OTHER_WORKSPACE_ID,
  WORKSPACE_COLORS,
  chatWorkspace,
  lastActivity,
  workspaceOpenLabel,
} from '@/lib/format';

export default function WorkspaceScreen() {
  const { id, room } = useLocalSearchParams<{ id: string; room?: string }>();
  const snap = useHeyLoop();
  const router = useRouter();
  const { colors } = useTheme();

  const isOther = id === OTHER_WORKSPACE_ID;
  const machineObj = room ? snap.machines.find((m) => m.room === room) : undefined;
  const workspace = !isOther && id ? machineObj?.workspaces.find((w) => w.id === id) : undefined;
  const hasRoomChats =
    !isOther && Boolean(id && machineObj && snap.chats.some((c) => c.room === machineObj.room && c.workspace_id === id));

  if (!id || !room || !machineObj || (!isOther && !workspace && !hasRoomChats)) {
    return (
      <View style={styles.fill}>
        <Stack.Screen options={{ title: 'Workspace' }} />
        <Text style={[styles.empty, { color: colors.text }]}>Workspace not found.</Text>
      </View>
    );
  }

  const name = isOther ? 'Other' : (workspace?.name ?? 'Workspace');
  const isOpen = !isOther && machineObj.status === 'online' && machineObj.computerOnline && Boolean(workspace?.open);
  const machine = machineObj.name;

  const chats = snap.chats
    .filter((c) =>
      isOther
        ? c.room === machineObj.room && !chatWorkspace(c, snap.machines)
        : c.room === machineObj.room && c.workspace_id === id,
    )
    .sort((a, b) =>
      lastActivity(b, snap.messages[chatKey(b.room, b.chat_id)]).localeCompare(
        lastActivity(a, snap.messages[chatKey(a.room, a.chat_id)]),
      ),
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
              disabled={!isOpen || !machineObj}
              onPress={() => {
                if (!machineObj) return;
                router.push({
                  pathname: '/new',
                  params: { workspace: id, room: machineObj.room },
                });
              }}
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
        keyExtractor={(c) => `${c.room}:${c.chat_id}`}
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
