import type { MessageBody } from '@heyloop/protocol';
import { useTheme } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View, type ColorValue } from 'react-native';
import { useAction } from '@/lib/use-action';

type Request = Extract<MessageBody, { kind: 'approval_request' }>;
type Option = NonNullable<Request['options']>[number];

const DANGER = '#e5484d';
const NEUTRAL = '#6b7280';
const MAX_TIMER_MS = 2 ** 31 - 1;

function useExpired(expiresAt: string): boolean {
  const at = Date.parse(expiresAt);
  const [expired, setExpired] = useState(Date.now() >= at);
  useEffect(() => {
    const ms = at - Date.now();
    if (ms <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), Math.min(ms, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [at]);
  return expired;
}

/** Answer controls for a pending approval; the daemon stays the authority on expiry and first-answer-wins. */
export function ApprovalActions({ request, room }: { request: Request; room: string }) {
  const { colors } = useTheme();
  const expired = useExpired(request.expires_at);
  const { busy, error, run } = useAction(room, request.request_id);
  const [sent, setSent] = useState(false);
  const [text, setText] = useState('');

  if (expired) return <Text style={[styles.note, { color: colors.text }]}>Expired</Text>;
  if (sent) return <Text style={[styles.note, { color: colors.text }]}>Sent. Waiting for your computer to confirm…</Text>;

  const answer = async (key: string, payload: { option_id?: string; text?: string }) => {
    if (await run(key, { type: 'answer', request_id: request.request_id, ...payload }, room, request.request_id)) {
      setSent(true);
    }
  };

  const choose = (option: Option) => {
    const commit = () => void answer(option.id, { option_id: option.id });
    if (request.risk !== 'high' || option.style === 'danger') return commit();
    const detail = request.command ? `\n\n${request.command}` : '';
    Alert.alert(`${option.label}?`, `${request.question}${detail}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: option.label, onPress: commit },
    ]);
  };

  const trimmed = text.trim();

  return (
    <View style={styles.wrap}>
      {request.input === 'text' ? (
        <>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Your answer"
            placeholderTextColor={colors.border}
            multiline
            maxLength={4000}
            editable={!busy}
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
          />
          <ActionButton
            label="Send"
            disabled={busy || !trimmed}
            color={colors.primary}
            onPress={() => void answer(`text:${trimmed}`, { text: trimmed })}
          />
        </>
      ) : (
        <View style={styles.row}>
          {(request.options ?? []).map((option) => (
            <ActionButton
              key={option.id}
              label={option.label}
              disabled={busy}
              color={option.style === 'danger' ? DANGER : option.style === 'primary' ? colors.primary : NEUTRAL}
              onPress={() => choose(option)}
            />
          ))}
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function ActionButton(props: { label: string; color: ColorValue; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, { backgroundColor: props.color, opacity: props.disabled ? 0.5 : 1 }]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, minWidth: 88, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8, minHeight: 44, maxHeight: 120 },
  note: { fontSize: 13, opacity: 0.7, marginTop: 4 },
  error: { color: DANGER, fontSize: 13 },
});
