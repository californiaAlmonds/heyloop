import { Link, Redirect, Stack, useTheme } from 'expo-router';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { client, useHeyLoop, type Snapshot } from '@/lib/client';
import { STATUS_COLORS, describe, formatTime, lastActivity, pendingApprovals } from '@/lib/format';

export default function ChatList() {
  const snap = useHeyLoop();
  const { colors } = useTheme();

  if (!snap.loaded) return <ActivityIndicator style={styles.fill} />;
  if (!snap.pairing) return <Redirect href="/pair" />;

  const chats = [...snap.chats].sort((a, b) =>
    lastActivity(b, snap.messages[b.chat_id]).localeCompare(lastActivity(a, snap.messages[a.chat_id])),
  );

  const confirmUnpair = () =>
    Alert.alert('Unpair this computer?', 'You will need to scan its QR code again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unpair', style: 'destructive', onPress: () => void client.unpair() },
    ]);

  return (
    <View style={styles.fill}>
      <Stack.Screen
        options={{
          title: snap.pairing.name,
          headerRight: () => (
            <Pressable onPress={confirmUnpair} hitSlop={8}>
              <Text style={{ color: colors.primary }}>Unpair</Text>
            </Pressable>
          ),
        }}
      />
      <ConnectionBanner snap={snap} />
      <FlatList
        data={chats}
        keyExtractor={(c) => c.chat_id}
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.text }]}>
            No chats yet. They appear when an agent calls a HeyLoop tool.
          </Text>
        }
        renderItem={({ item }) => {
          const envelopes = snap.messages[item.chat_id] ?? [];
          const pending = pendingApprovals(envelopes).length;
          const last = envelopes.findLast((e) => describe(e.body));
          return (
            <Link href={{ pathname: '/chat/[id]', params: { id: item.chat_id } }} asChild>
              <Pressable style={styles.row}>
                <View style={[styles.dot, { backgroundColor: STATUS_COLORS[item.status] }]} />
                <View style={styles.rowBody}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={[styles.time, { color: colors.text }]}>
                      {formatTime(lastActivity(item, envelopes))}
                    </Text>
                  </View>
                  <Text style={[styles.preview, { color: colors.text }]} numberOfLines={2}>
                    {pending > 0
                      ? `⏳ ${pending} approval${pending > 1 ? 's' : ''} waiting`
                      : last
                        ? describe(last.body)
                        : ' '}
                  </Text>
                </View>
              </Pressable>
            </Link>
          );
        }}
      />
    </View>
  );
}

function ConnectionBanner({ snap }: { snap: Snapshot }) {
  let message: string | undefined;
  if (snap.status === 'connecting') message = 'Connecting to relay…';
  else if (snap.status === 'offline') message = 'Relay unreachable. Retrying…';
  else if (snap.status === 'unauthorized')
    message = 'Relay rejected this pairing. Make sure the HeyLoop daemon is running and connected, then retry.';
  else if (!snap.computerOnline) message = `${snap.pairing?.name ?? 'Computer'} is offline. Showing cached chats.`;
  if (!message) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{message}</Text>
      {snap.status !== 'connecting' && snap.status !== 'online' && (
        <Pressable onPress={() => client.reconnectNow()} hitSlop={8}>
          <Text style={styles.bannerAction}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
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
  dot: { width: 12, height: 12, borderRadius: 6 },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  time: { fontSize: 12, opacity: 0.6 },
  preview: { fontSize: 14, opacity: 0.7 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 40 },
  empty: { padding: 24, textAlign: 'center', opacity: 0.6 },
});
