import { useTheme } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeyLoop } from '@/lib/client';
import { chatMachine } from '@/lib/format';
import { useAction } from '@/lib/use-action';

const DANGER = '#e5484d';

export function Composer({ chatId, room }: { chatId: string; room: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const snap = useHeyLoop();
  const chat = snap.chats.find((c) => c.room === room && c.chat_id === chatId);
  const machine = chatMachine(chat ?? { room }, snap.machines);
  const { busy, error, run } = useAction(room, chatId);
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
  const body = text.trim();
  const online = machine?.status === 'online';
  const computerOnline = Boolean(machine?.computerOnline);

  const send = async () => {
    if (!body || busy) return;
    if (await run(body, { type: 'say', chat_id: chatId, text: body }, room, chatId)) setText('');
  };

  return (
    <View style={[styles.wrap, { borderColor: colors.border, paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom) }]}>
      {online && !computerOnline && (
        <Text style={[styles.hint, { color: colors.text }]}>Computer offline. Messages are delivered when it reconnects.</Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message the agent"
          placeholderTextColor={colors.border}
          multiline
          maxLength={4000}
          editable={!busy}
          style={[styles.input, { color: colors.text, borderColor: colors.border }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          disabled={!online || busy || !body}
          onPress={() => void send()}
          style={[styles.send, { backgroundColor: colors.primary, opacity: !online || busy || !body ? 0.4 : 1 }]}
        >
          <Text style={styles.sendText}>{busy ? '…' : error ? 'Retry' : 'Send'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function RenameModal(props: { chatId: string; room: string; current: string; onClose: () => void }) {
  const { colors } = useTheme();
  const { busy, error, run } = useAction(props.room, props.chatId);
  const [title, setTitle] = useState(props.current);
  const trimmed = title.trim();

  const save = async () => {
    if (!trimmed || busy) return;
    if (
      trimmed === props.current ||
      (await run(trimmed, { type: 'rename', chat_id: props.chatId, title: trimmed }, props.room, props.chatId))
    ) {
      props.onClose();
    }
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={props.onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.text }]}>Rename chat</Text>
          <TextInput
            autoFocus
            value={title}
            onChangeText={setTitle}
            maxLength={80}
            editable={!busy}
            onSubmitEditing={() => void save()}
            style={[styles.titleInput, { color: colors.text, borderColor: colors.border }]}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <View style={styles.actions}>
            <Pressable onPress={props.onClose} disabled={busy}>
              <Text style={[styles.link, { color: colors.text }]}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => void save()} disabled={busy || !trimmed}>
              <Text style={[styles.link, { color: colors.primary, opacity: busy || !trimmed ? 0.4 : 1 }]}>Save</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, maxHeight: 120 },
  send: { paddingHorizontal: 16, height: 40, borderRadius: 20, justifyContent: 'center' },
  sendText: { color: '#fff', fontWeight: '600' },
  hint: { fontSize: 12, opacity: 0.6 },
  error: { color: DANGER, fontSize: 13 },
  backdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.4)' },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12 },
  title: { fontSize: 17, fontWeight: '600' },
  titleInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 24 },
  link: { fontSize: 16, fontWeight: '600' },
});
