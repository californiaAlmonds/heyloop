import { Redirect, Stack, useRouter, useTheme } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChatRow } from '@/components/ChatRow';
import { client, useHeyLoop, type Snapshot } from '@/lib/client';
import {
  OTHER_WORKSPACE_ID,
  WORKSPACE_COLORS,
  chatCountLabel,
  chatWorkspace,
  formatTime,
  lastActivity,
  machineName,
  workspaceCountLabel,
  workspaceOpenLabel,
} from '@/lib/format';

type Filter = 'chats' | 'workspaces' | 'favourites' | 'machines';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'chats', label: 'Chats' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'machines', label: 'Machines' },
];

interface WorkspaceGroup {
  id: string;
  name: string;
  open: boolean;
  isOther: boolean;
  chatCount: number;
  lastTs?: string;
}

export default function ChatList() {
  const snap = useHeyLoop();
  const router = useRouter();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<Filter>('chats');

  if (!snap.loaded) return <ActivityIndicator style={styles.fill} />;
  if (!snap.pairing) return <Redirect href="/pair" />;

  const machine = machineName(snap);
  const computerConnected = snap.status === 'online' && snap.computerOnline;
  const chats = [...snap.chats].sort((a, b) =>
    lastActivity(b, snap.messages[b.chat_id]).localeCompare(lastActivity(a, snap.messages[a.chat_id])),
  );
  const hasOpenWorkspace = computerConnected && snap.workspaces.some((w) => w.open);

  const confirmUnpair = () =>
    Alert.alert('Unpair this computer?', 'You will need to scan its QR code again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unpair', style: 'destructive', onPress: () => void client.unpair() },
    ]);

  const workspaceGroups: WorkspaceGroup[] = snap.workspaces.map((w) => {
    const wsChats = chats.filter((c) => c.workspace_id === w.id);
    const lastTs = wsChats.length > 0 ? lastActivity(wsChats[0], snap.messages[wsChats[0].chat_id]) : undefined;
    return {
      id: w.id,
      name: w.name,
      open: computerConnected && Boolean(w.open),
      isOther: false,
      chatCount: wsChats.length,
      lastTs,
    };
  });

  const otherChats = chats.filter((c) => !chatWorkspace(c, snap.workspaces));
  if (otherChats.length > 0) {
    workspaceGroups.push({
      id: OTHER_WORKSPACE_ID,
      name: 'Other',
      open: false,
      isOther: true,
      chatCount: otherChats.length,
      lastTs: lastActivity(otherChats[0], snap.messages[otherChats[0].chat_id]),
    });
  }

  workspaceGroups.sort((a, b) => {
    if (a.isOther !== b.isOther) return a.isOther ? 1 : -1;
    if (a.open !== b.open) return a.open ? -1 : 1;
    if ((a.lastTs ?? '') !== (b.lastTs ?? '')) return (b.lastTs ?? '').localeCompare(a.lastTs ?? '');
    return a.name.localeCompare(b.name);
  });

  const favouriteChats = chats.filter((c) => snap.favourites.has(c.chat_id));

  return (
    <View style={styles.fill}>
      <Stack.Screen
        options={{
          title: machine,
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New chat"
              disabled={!hasOpenWorkspace}
              onPress={() => router.push('/new')}
              hitSlop={8}
            >
              <Text style={[styles.headerAction, { color: colors.primary, opacity: hasOpenWorkspace ? 1 : 0.4 }]}>
                New chat
              </Text>
            </Pressable>
          ),
        }}
      />
      <ConnectionBanner snap={snap} />
      {computerConnected && !hasOpenWorkspace && (
        <Text style={[styles.hint, { color: colors.text, borderColor: colors.border }]}>
          Open VS Code with the HeyLoop extension
        </Text>
      )}
      <View style={[styles.chipsWrap, { borderColor: colors.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {FILTERS.map((chip) => {
            const selected = filter === chip.id;
            return (
              <Pressable
                key={chip.id}
                accessibilityRole="button"
                accessibilityLabel={chip.label}
                accessibilityState={{ selected }}
                onPress={() => setFilter(chip.id)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: selected ? colors.primary : colors.card,
                    borderColor: selected ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text style={[styles.chipText, { color: selected ? '#fff' : colors.text }]}>{chip.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {filter === 'chats' && (
        <FlatList
          data={chats}
          keyExtractor={(c) => c.chat_id}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.text }]}>
              No chats yet. They appear when an agent calls a HeyLoop tool.
            </Text>
          }
          renderItem={({ item }) => <ChatRow chat={item} />}
        />
      )}

      {filter === 'workspaces' && (
        <FlatList
          data={workspaceGroups}
          keyExtractor={(w) => w.id}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.text }]}>
              No workspaces yet. Open VS Code with the HeyLoop extension.
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${workspaceOpenLabel(item)}, ${chatCountLabel(item.chatCount)}`}
              onPress={() => router.push({ pathname: '/workspace/[id]', params: { id: item.id } })}
              style={styles.row}
            >
              <View style={[styles.dot, { backgroundColor: WORKSPACE_COLORS[item.open ? 'open' : 'closed'] }]} />
              <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                  <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.lastTs && <Text style={[styles.time, { color: colors.text }]}>{formatTime(item.lastTs)}</Text>}
                </View>
                <Text style={[styles.preview, { color: colors.text }]} numberOfLines={1}>
                  {workspaceOpenLabel(item)} · {chatCountLabel(item.chatCount)}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}

      {filter === 'favourites' && (
        <FlatList
          data={favouriteChats}
          keyExtractor={(c) => c.chat_id}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.text }]}>
              No favourite chats yet. Long-press a chat or tap the star in a chat to add one.
            </Text>
          }
          renderItem={({ item }) => <ChatRow chat={item} />}
        />
      )}

      {filter === 'machines' && (
        <View style={styles.fill}>
          <View style={[styles.machineRow, { borderColor: colors.border }]}>
            <View style={[styles.dot, { backgroundColor: WORKSPACE_COLORS[computerConnected ? 'open' : 'closed'] }]} />
            <View style={styles.rowBody}>
              <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                {machine}
              </Text>
              <Text style={[styles.preview, { color: colors.text }]}>
                {computerConnected ? 'Online' : 'Offline'} · {workspaceCountLabel(snap.workspaces.length)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Unpair ${machine}`}
              onPress={confirmUnpair}
              hitSlop={8}
              style={[styles.unpairButton, { borderColor: colors.border }]}
            >
              <Text style={styles.unpairText}>Unpair</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function ConnectionBanner({ snap }: { snap: Snapshot }) {
  let message: string | undefined;
  if (snap.status === 'connecting') message = 'Connecting to relay…';
  else if (snap.status === 'offline') message = 'Relay unreachable. Retrying…';
  else if (snap.status === 'unauthorized')
    message = 'Relay rejected this pairing. Make sure the HeyLoop daemon is running and connected, then retry.';
  else if (!snap.computerOnline) message = `${machineName(snap)} is offline. Showing cached chats.`;
  if (!message) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{message}</Text>
      {snap.status !== 'connecting' && snap.status !== 'online' && (
        <Pressable accessibilityRole="button" accessibilityLabel="Retry connection" onPress={() => client.reconnectNow()} hitSlop={8}>
          <Text style={styles.bannerAction}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  headerAction: { fontWeight: '600' },
  hint: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 13,
    opacity: 0.7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chipsWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff4d6',
  },
  bannerText: { flex: 1, color: '#5c4400' },
  bannerAction: { color: '#5c4400', fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  machineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  time: { fontSize: 12, opacity: 0.6 },
  preview: { fontSize: 14, opacity: 0.7 },
  unpairButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  unpairText: { color: '#e5484d', fontWeight: '600', fontSize: 13 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 40 },
  empty: { padding: 24, textAlign: 'center', opacity: 0.6 },
});
