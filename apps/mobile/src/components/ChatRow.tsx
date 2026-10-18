import { useRouter, useTheme } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { chatKey, client, useHeyLoop, type PairedChat } from '@/lib/client';
import {
  STATUS_COLORS,
  WORKSPACE_COLORS,
  chatLocationLabel,
  chatWorkspace,
  describe,
  formatTime,
  lastActivity,
  machineName,
  pendingApprovals,
} from '@/lib/format';

const STAR_COLOR = '#f2a20c';

export function ChatRow({ chat }: { chat: PairedChat }) {
  const snap = useHeyLoop();
  const router = useRouter();
  const { colors } = useTheme();

  const key = chatKey(chat.room, chat.chat_id);
  const envelopes = snap.messages[key] ?? [];
  const pending = pendingApprovals(envelopes).length;
  const last = envelopes.findLast((e) => describe(e.body));
  const workspace = chatWorkspace(chat, snap.machines);
  const machine = machineName(chat, snap.machines);
  const subtitle = chatLocationLabel(workspace, machine);
  const favourited = snap.favourites.has(key);
  const favActionLabel = favourited ? 'Remove from favourites' : 'Add to favourites';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${chat.title}${subtitle ? `, ${subtitle}` : ''}${favourited ? ', Favourited' : ''}`}
      accessibilityHint="Long press to toggle favourite"
      accessibilityActions={[{ name: 'favourite', label: favActionLabel }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'favourite') {
          client.toggleFavourite(chat.room, chat.chat_id);
        }
      }}
      onPress={() => router.push({ pathname: '/chat/[id]', params: { id: chat.chat_id, room: chat.room } })}
      onLongPress={() => client.toggleFavourite(chat.room, chat.chat_id)}
      style={styles.row}
    >
      <View style={[styles.dot, { backgroundColor: STATUS_COLORS[chat.status] }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {chat.title}
          </Text>
          {favourited && (
            <Text accessibilityLabel="Favourited" style={styles.star}>
              ★
            </Text>
          )}
          <Text style={[styles.time, { color: colors.text }]}>{formatTime(lastActivity(chat, envelopes))}</Text>
        </View>
        {Boolean(subtitle) && (
          <View style={styles.subtitleRow}>
            {workspace && (
              <View
                style={[
                  styles.wsDot,
                  { backgroundColor: WORKSPACE_COLORS[workspace.open ? 'open' : 'closed'] },
                ]}
              />
            )}
            <Text style={[styles.subtitle, { color: colors.text }]} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        )}
        <Text style={[styles.preview, { color: colors.text }]} numberOfLines={2}>
          {pending > 0
            ? `⏳ ${pending} approval${pending > 1 ? 's' : ''} waiting`
            : last
              ? describe(last.body)
              : ' '}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  star: { color: STAR_COLOR, fontSize: 14 },
  time: { fontSize: 12, opacity: 0.6 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  wsDot: { width: 7, height: 7, borderRadius: 3.5 },
  subtitle: { flex: 1, fontSize: 12, opacity: 0.65 },
  preview: { fontSize: 14, opacity: 0.7 },
});
