import type { Envelope } from '@heyloop/protocol';
import { Stack, useLocalSearchParams, useTheme } from 'expo-router';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import { useHeyLoop } from '@/lib/client';
import { STATUS_COLORS, STATUS_LABELS, describe, formatTime, pendingApprovals } from '@/lib/format';

const LEVEL_COLORS = { info: '#9aa0a6', progress: '#2f80ed', success: '#30a46c', warning: '#f2a20c', error: '#e5484d' };

export default function Conversation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const snap = useHeyLoop();
  const { colors } = useTheme();
  const chat = snap.chats.find((c) => c.chat_id === id);
  const envelopes = snap.messages[id] ?? [];
  const pending = new Set(pendingApprovals(envelopes).map((r) => r.request_id));
  const visible = envelopes.filter((e) => describe(e.body)).reverse();

  return (
    <View style={styles.fill}>
      <Stack.Screen options={{ title: chat?.title ?? 'Chat' }} />
      {chat && (
        <View style={[styles.statusBar, { borderColor: colors.border }]}>
          <View style={[styles.dot, { backgroundColor: STATUS_COLORS[chat.status] }]} />
          <Text style={{ color: colors.text }}>{STATUS_LABELS[chat.status]}</Text>
        </View>
      )}
      <FlatList
        inverted
        data={visible}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => <Message envelope={item} pending={pending} />}
      />
    </View>
  );
}

function Message({ envelope, pending }: { envelope: Envelope; pending: Set<string> }) {
  const { colors } = useTheme();
  const { body, sender, ts } = envelope;

  if (sender === 'system' || body.kind === 'approval_resolved' || body.kind === 'chat_meta') {
    return <Text style={[styles.system, { color: colors.text }]}>{describe(body)}</Text>;
  }

  const mine = sender === 'user';
  const bubble = [
    styles.bubble,
    mine ? [styles.mine, { backgroundColor: colors.primary }] : { backgroundColor: colors.card, borderColor: colors.border },
  ];
  const textColor = { color: mine ? '#fff' : colors.text };

  return (
    <View style={bubble}>
      {body.kind === 'status' && (
        <View style={[styles.level, { backgroundColor: LEVEL_COLORS[body.level] }]} />
      )}
      {body.kind === 'approval_request' ? (
        <>
          <Text style={[styles.label, textColor]}>
            Approval · {body.risk} risk{pending.has(body.request_id) ? ' · waiting' : ''}
          </Text>
          <Text style={[styles.text, textColor]}>{body.question}</Text>
          {body.context && <Text style={[styles.detail, textColor]}>{body.context}</Text>}
          {body.command && (
            <Text selectable style={[styles.command, { color: colors.text, borderColor: colors.border }]}>
              {body.command}
            </Text>
          )}
        </>
      ) : (
        <>
          <Text style={[styles.text, textColor]}>
            {describe(body)}
            {body.kind === 'status' && body.progress !== undefined ? ` (${body.progress}%)` : ''}
          </Text>
          {body.kind === 'status' && body.detail && <Text style={[styles.detail, textColor]}>{body.detail}</Text>}
        </>
      )}
      <Text style={[styles.time, textColor]}>{formatTime(ts)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  list: { padding: 12, gap: 8 },
  system: { alignSelf: 'center', fontSize: 12, opacity: 0.6, marginVertical: 4 },
  bubble: {
    maxWidth: '85%',
    alignSelf: 'flex-start',
    padding: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
    overflow: 'hidden',
  },
  mine: { alignSelf: 'flex-end', borderWidth: 0 },
  level: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  label: { fontSize: 12, fontWeight: '600', opacity: 0.7 },
  text: { fontSize: 15 },
  detail: { fontSize: 13, opacity: 0.8 },
  command: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 12,
    padding: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  time: { fontSize: 11, opacity: 0.5, alignSelf: 'flex-end' },
});
