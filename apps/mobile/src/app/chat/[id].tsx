import type { Envelope, MessageBody } from '@heyloop/protocol';
import { Stack, useLocalSearchParams, useTheme } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApprovalActions } from '@/components/ApprovalActions';
import { Composer, RenameModal } from '@/components/Composer';
import { chatKey, client, useHeyLoop } from '@/lib/client';
import {
  STATUS_COLORS,
  STATUS_LABELS,
  chatLocationLabel,
  chatWorkspace,
  describe,
  formatTime,
  machineName,
  pendingApprovals,
} from '@/lib/format';

const LEVEL_COLORS = { info: '#9aa0a6', progress: '#2f80ed', success: '#30a46c', warning: '#f2a20c', error: '#e5484d' };
const HIGHLIGHT_COLOR = '#f2a20c';
const HIGHLIGHT_MS = 1500;

type ApprovalResponse = Extract<MessageBody, { kind: 'approval_response' }>;

function answerLabel(body: ApprovalResponse, quoted?: Envelope): string {
  if (body.text) return body.text;
  const request = quoted?.body.kind === 'approval_request' ? quoted.body : undefined;
  return request?.options?.find((o) => o.id === body.option_id)?.label ?? body.option_id ?? 'Answered';
}

export default function Conversation() {
  const { id, room } = useLocalSearchParams<{ id: string; room?: string }>();
  const snap = useHeyLoop();
  const { colors } = useTheme();
  const headerHeight = useHeaderHeight();
  const machineObj = room ? snap.machines.find((m) => m.room === room) : undefined;
  const chat = room && id ? snap.chats.find((c) => c.room === room && c.chat_id === id) : undefined;
  const key = room && id ? chatKey(room, id) : undefined;
  const workspace = chatWorkspace(chat, snap.machines);
  const machine = machineName(chat, snap.machines);
  const location = chatLocationLabel(workspace, machine);
  const favourited = Boolean(key && snap.favourites.has(key));
  const envelopes = key ? (snap.messages[key] ?? []) : [];
  const pending = new Set(pendingApprovals(envelopes).map((r) => r.request_id));
  const requests = new Map(
    envelopes.flatMap((e) => (e.body.kind === 'approval_request' ? [[e.body.request_id, e] as const] : [])),
  );
  const visible = envelopes.filter((e) => describe(e.body)).reverse();
  const [renaming, setRenaming] = useState(false);
  const [highlight, setHighlight] = useState<string>();
  const list = useRef<FlatList<Envelope>>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!room || !id || !machineObj || !chat) {
    return (
      <View style={styles.fill}>
        <Stack.Screen options={{ title: 'Chat' }} />
        <Text style={[styles.notFound, { color: colors.text }]}>Chat not found.</Text>
      </View>
    );
  }

  const jumpTo = (envelopeId: string) => {
    const index = visible.findIndex((e) => e.id === envelopeId);
    if (index < 0) return;
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setHighlight(envelopeId);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlight(undefined), HIGHLIGHT_MS);
  };

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={headerHeight} style={styles.fill}>
      <Stack.Screen
        options={{
          title: chat.title,
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={favourited ? 'Remove from favourites' : 'Add to favourites'}
                accessibilityState={{ selected: favourited }}
                onPress={() => client.toggleFavourite(chat.room, chat.chat_id)}
                hitSlop={8}
              >
                <Text style={[styles.star, { color: favourited ? HIGHLIGHT_COLOR : colors.text }]}>
                  {favourited ? '★' : '☆'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Rename chat"
                onPress={() => setRenaming(true)}
                hitSlop={8}
              >
                <Text style={{ color: colors.primary, fontSize: 16 }}>Rename</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      <View style={[styles.statusBar, { borderColor: colors.border }]}>
        <View style={[styles.dot, { backgroundColor: STATUS_COLORS[chat.status] }]} />
        <Text style={{ color: colors.text }}>{STATUS_LABELS[chat.status]}</Text>
        {Boolean(location) && (
          <Text style={[styles.location, { color: colors.text }]} numberOfLines={1}>
            {location}
          </Text>
        )}
      </View>
      {workspace && !workspace.open && (
        <View style={styles.closedBanner}>
          <Text style={styles.closedBannerText}>
            {`${workspace.name} isn't open on ${machine}. Messages will be delivered when it opens.`}
          </Text>
        </View>
      )}
      <FlatList
        ref={list}
        inverted
        data={visible}
        extraData={highlight}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          // Target isn't rendered yet: approximate the offset, then retry once it is measured.
          list.current?.scrollToOffset({ offset: index * averageItemLength, animated: true });
          setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 150);
        }}
        renderItem={({ item }) => (
          <Message
            envelope={item}
            room={chat.room}
            pending={pending}
            highlighted={item.id === highlight}
            quoted={item.body.kind === 'approval_response' ? requests.get(item.body.request_id) : undefined}
            onQuotePress={jumpTo}
          />
        )}
      />
      <Composer chatId={chat.chat_id} room={chat.room} />
      {renaming && (
        <RenameModal chatId={chat.chat_id} room={chat.room} current={chat.title} onClose={() => setRenaming(false)} />
      )}
    </KeyboardAvoidingView>
  );
}

function Message(props: {
  envelope: Envelope;
  room: string;
  pending: Set<string>;
  highlighted: boolean;
  quoted?: Envelope;
  onQuotePress: (envelopeId: string) => void;
}) {
  const { envelope, room, pending, highlighted, quoted, onQuotePress } = props;
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
      {highlighted && <View pointerEvents="none" style={styles.highlight} />}
      {body.kind === 'status' && (
        <View style={[styles.level, { backgroundColor: LEVEL_COLORS[body.level] }]} />
      )}
      {body.kind === 'approval_response' && quoted?.body.kind === 'approval_request' && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show the original question"
          onPress={() => onQuotePress(quoted.id)}
          style={styles.quote}
        >
          <Text style={styles.quoteLabel}>Agent asked</Text>
          <Text numberOfLines={2} style={styles.quoteText}>
            {quoted.body.question}
          </Text>
        </Pressable>
      )}
      {body.kind === 'approval_response' ? (
        <Text style={[styles.text, textColor]}>{answerLabel(body, quoted)}</Text>
      ) : body.kind === 'approval_request' ? (
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
          {pending.has(body.request_id) && <ApprovalActions request={body} room={room} />}
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
  notFound: { padding: 24, textAlign: 'center', opacity: 0.6 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  star: { fontSize: 20 },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  location: { flex: 1, fontSize: 12, opacity: 0.65, textAlign: 'right' },
  closedBanner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#fff4d6',
  },
  closedBannerText: { color: '#5c4400', fontSize: 13 },
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
  highlight: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderWidth: 2, borderColor: HIGHLIGHT_COLOR, borderRadius: 12 },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: '#fff',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  quoteLabel: { color: '#fff', fontSize: 11, fontWeight: '700', opacity: 0.85 },
  quoteText: { color: '#fff', fontSize: 13, opacity: 0.9 },
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
