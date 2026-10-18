import { Redirect, Stack, useRouter, useTheme } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChatRow } from '@/components/ChatRow';
import { chatKey, client, useHeyLoop, type PairedMachine, type Snapshot } from '@/lib/client';
import {
  OTHER_WORKSPACE_ID,
  WORKSPACE_COLORS,
  chatCountLabel,
  chatWorkspace,
  formatTime,
  lastActivity,
  relayHost,
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
  key: string;
  id: string;
  room: string;
  name: string;
  machineName?: string;
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
  if (snap.storageError) {
    return (
      <View style={styles.storageErrorWrap}>
        <Text style={[styles.storageErrorText, { color: colors.text }]}>{snap.storageError}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading paired computers"
          onPress={() => void client.retryInit().catch(() => undefined)}
          style={[styles.addButton, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.addButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (snap.machines.length === 0) return <Redirect href="/pair" />;

  const title = snap.machines.length === 1 ? snap.machines[0].name : 'HeyLoop';
  const anyComputerConnected = snap.machines.some((m) => m.status === 'online' && m.computerOnline);
  const chats = [...snap.chats].sort((a, b) =>
    lastActivity(b, snap.messages[chatKey(b.room, b.chat_id)]).localeCompare(
      lastActivity(a, snap.messages[chatKey(a.room, a.chat_id)]),
    ),
  );
  const hasOpenWorkspace = snap.machines.some(
    (m) => m.status === 'online' && m.computerOnline && m.workspaces.some((w) => w.open),
  );

  const confirmUnpair = (machine: PairedMachine) =>
    Alert.alert(
      `Unpair ${machine.name}?`,
      'This removes its cached chats from this phone. You will need to scan its QR code again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpair',
          style: 'destructive',
          onPress: () => {
            void client.unpair(machine.room).catch((e) => {
              Alert.alert('Could not unpair', e instanceof Error ? e.message : 'Try again.');
            });
          },
        },
      ],
    );

  const workspaceGroups: WorkspaceGroup[] = snap.machines.flatMap((m) => {
    const computerConnected = m.status === 'online' && m.computerOnline;
    const groups: WorkspaceGroup[] = m.workspaces.map((w) => {
      const wsChats = chats.filter((c) => c.room === m.room && c.workspace_id === w.id);
      const lastTs =
        wsChats.length > 0
          ? lastActivity(wsChats[0], snap.messages[chatKey(wsChats[0].room, wsChats[0].chat_id)])
          : undefined;
      return {
        key: `${m.room}:${w.id}`,
        id: w.id,
        room: m.room,
        name: w.name,
        machineName: m.name,
        open: computerConnected && Boolean(w.open),
        isOther: false,
        chatCount: wsChats.length,
        lastTs,
      };
    });
    const otherChats = chats.filter((c) => c.room === m.room && !chatWorkspace(c, snap.machines));
    if (otherChats.length > 0) {
      groups.push({
        key: `${m.room}:${OTHER_WORKSPACE_ID}`,
        id: OTHER_WORKSPACE_ID,
        room: m.room,
        name: 'Other',
        machineName: m.name,
        open: false,
        isOther: true,
        chatCount: otherChats.length,
        lastTs: lastActivity(otherChats[0], snap.messages[chatKey(otherChats[0].room, otherChats[0].chat_id)]),
      });
    }
    return groups;
  });

  workspaceGroups.sort((a, b) => {
    if (a.isOther !== b.isOther) return a.isOther ? 1 : -1;
    if (a.open !== b.open) return a.open ? -1 : 1;
    if ((a.lastTs ?? '') !== (b.lastTs ?? '')) return (b.lastTs ?? '').localeCompare(a.lastTs ?? '');
    return a.name.localeCompare(b.name) || (a.machineName ?? '').localeCompare(b.machineName ?? '');
  });

  const favouriteChats = chats.filter((c) => snap.favourites.has(chatKey(c.room, c.chat_id)));

  return (
    <View style={styles.fill}>
      <Stack.Screen
        options={{
          title,
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
      {anyComputerConnected && !hasOpenWorkspace && (
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
          keyExtractor={(c) => `${c.room}:${c.chat_id}`}
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
          keyExtractor={(w) => w.key}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.text }]}>
              No workspaces yet. Open VS Code with the HeyLoop extension.
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}${item.machineName ? `, ${item.machineName}` : ''}, ${workspaceOpenLabel(item)}, ${chatCountLabel(item.chatCount)}`}
              onPress={() =>
                router.push({
                  pathname: '/workspace/[id]',
                  params: { id: item.id, room: item.room },
                })
              }
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
                  {[item.machineName, workspaceOpenLabel(item), chatCountLabel(item.chatCount)].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}

      {filter === 'favourites' && (
        <FlatList
          data={favouriteChats}
          keyExtractor={(c) => `${c.room}:${c.chat_id}`}
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
        <FlatList
          data={snap.machines}
          keyExtractor={(m) => m.room}
          renderItem={({ item: m }) => {
            const computerConnected = m.status === 'online' && m.computerOnline;
            const openCount = computerConnected ? m.workspaces.filter((w) => w.open).length : 0;
            const relayStatusLabel =
              m.status === 'online'
                ? 'Relay online'
                : m.status === 'connecting'
                  ? 'Relay connecting'
                  : m.status === 'unauthorized'
                    ? 'Relay unauthorized'
                    : 'Relay offline';
            const computerStatusLabel = computerConnected ? 'Computer online' : 'Computer offline';

            return (
              <View style={[styles.machineRow, { borderColor: colors.border }]}>
                <View style={[styles.dot, { backgroundColor: WORKSPACE_COLORS[computerConnected ? 'open' : 'closed'] }]} />
                <View style={styles.rowBody}>
                  <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                    {m.name}
                  </Text>
                  <Text style={[styles.preview, { color: colors.text }]} numberOfLines={1}>
                    {relayHost(m.relay)} · {relayStatusLabel}
                  </Text>
                  <Text style={[styles.preview, { color: colors.text }]} numberOfLines={1}>
                    {computerStatusLabel} · {workspaceCountLabel(openCount, true)}
                  </Text>
                </View>
                <View style={styles.machineActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Reconnect ${m.name}`}
                    onPress={() => client.reconnectNow(m.room)}
                    hitSlop={8}
                    style={[styles.machineButton, { borderColor: colors.border }]}
                  >
                    <Text style={[styles.reconnectText, { color: colors.primary }]}>Reconnect</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Unpair ${m.name}`}
                    onPress={() => confirmUnpair(m)}
                    hitSlop={8}
                    style={[styles.machineButton, { borderColor: colors.border }]}
                  >
                    <Text style={styles.unpairText}>Unpair</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
          ListFooterComponent={
            <View style={styles.footer}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add machine"
                onPress={() => router.push('/pair')}
                style={[styles.addButton, { backgroundColor: colors.primary }]}
              >
                <Text style={styles.addButtonText}>Add machine</Text>
              </Pressable>
            </View>
          }
        />
      )}
    </View>
  );
}

function ConnectionBanner({ snap }: { snap: Snapshot }) {
  const banners: { key: string; message: string; retryRoom?: string }[] = [];
  const offlineComputers: PairedMachine[] = [];

  for (const m of snap.machines) {
    if (m.status === 'connecting') {
      banners.push({
        key: m.room,
        message: snap.machines.length === 1 ? 'Connecting to relay…' : `${m.name}: connecting to relay…`,
      });
    } else if (m.status === 'offline') {
      banners.push({
        key: m.room,
        message: snap.machines.length === 1 ? 'Relay unreachable. Retrying…' : `${m.name}: relay unreachable. Retrying…`,
        retryRoom: m.room,
      });
    } else if (m.status === 'unauthorized') {
      banners.push({
        key: m.room,
        message:
          snap.machines.length === 1
            ? 'Relay rejected this pairing. Make sure the HeyLoop daemon is running and connected, then retry.'
            : `${m.name}: relay rejected this pairing. Make sure the HeyLoop daemon is running and connected, then retry.`,
        retryRoom: m.room,
      });
    } else if (!m.computerOnline) {
      offlineComputers.push(m);
    }
  }

  if (offlineComputers.length === 1) {
    banners.push({
      key: `peer:${offlineComputers[0].room}`,
      message: `${offlineComputers[0].name} is offline. Showing cached chats.`,
    });
  } else if (offlineComputers.length > 1) {
    banners.push({
      key: 'peer:summary',
      message: `${offlineComputers.map((m) => m.name).join(', ')} are offline. Showing cached chats.`,
    });
  }

  if (banners.length === 0) return null;

  return (
    <View>
      {banners.map((b) => (
        <View key={b.key} style={styles.banner}>
          <Text style={styles.bannerText}>{b.message}</Text>
          {b.retryRoom && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry connection"
              onPress={() => client.reconnectNow(b.retryRoom)}
              hitSlop={8}
            >
              <Text style={styles.bannerAction}>Retry</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  storageErrorWrap: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  storageErrorText: { fontSize: 15, textAlign: 'center', opacity: 0.8 },
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(92,68,0,0.15)',
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
  machineActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  machineButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reconnectText: { fontWeight: '600', fontSize: 13 },
  unpairText: { color: '#e5484d', fontWeight: '600', fontSize: 13 },
  footer: { padding: 16 },
  addButton: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
  },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  time: { fontSize: 12, opacity: 0.6 },
  preview: { fontSize: 14, opacity: 0.7 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 40 },
  empty: { padding: 24, textAlign: 'center', opacity: 0.6 },
});
