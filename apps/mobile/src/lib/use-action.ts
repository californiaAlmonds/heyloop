import { useCallback, useEffect, useRef, useState } from 'react';
import { client, type OutgoingFrame } from './client';
import { errorMessage } from './format';

interface Attempt {
  room: string;
  target: string;
  key: string;
  id: string;
}

function frameTarget(frame: OutgoingFrame): string | undefined {
  if ('chat_id' in frame) return frame.chat_id;
  if ('request_id' in frame) return frame.request_id;
  if ('workspace_id' in frame) return frame.workspace_id;
  return undefined;
}

/**
 * Runs one user action at a time; retrying the same `(room, target, key)` after 'unconfirmed' reuses the frame id.
 * Changing the target room or action target resets state and discards any unconfirmed attempt on its original room.
 */
export function useAction(room?: string, target?: string) {
  const attempt = useRef<Attempt>(undefined);
  const epoch = useRef(0);
  const activeTarget = useRef({ room, target });
  const [boundTarget, setBoundTarget] = useState({ room, target });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (boundTarget.room !== room || boundTarget.target !== target) {
    setBoundTarget({ room, target });
    setBusy(false);
    setError(undefined);
  }

  useEffect(() => {
    if (activeTarget.current.room === room && activeTarget.current.target === target) return;
    activeTarget.current = { room, target };
    epoch.current += 1;
    const prev = attempt.current;
    if (prev) {
      client.discard(prev.id, prev.room);
      attempt.current = undefined;
    }
    setBusy(false);
    setError(undefined);
  }, [room, target]);

  const run = useCallback(
    async (key: string, frame: OutgoingFrame, targetRoom?: string, targetId?: string): Promise<boolean> => {
      const frameTargetId = frameTarget(frame);
      const effectiveRoom = targetRoom ?? room;
      const effectiveTarget = targetId ?? target ?? frameTargetId;
      if (!effectiveRoom || !effectiveTarget || (frameTargetId && frameTargetId !== effectiveTarget)) {
        return false;
      }

      const prev = attempt.current;
      const sameAttempt =
        prev !== undefined &&
        prev.room === effectiveRoom &&
        prev.target === effectiveTarget &&
        prev.key === key;
      if (prev && !sameAttempt) {
        client.discard(prev.id, prev.room);
        attempt.current = undefined;
      }

      const runEpoch = ++epoch.current;
      setBusy(true);
      setError(undefined);
      const res = await client.submit(frame, sameAttempt ? prev.id : undefined, effectiveRoom);
      if (epoch.current !== runEpoch) {
        if (res.error === 'unconfirmed') client.discard(res.id, effectiveRoom);
        return false;
      }
      attempt.current =
        res.error === 'unconfirmed'
          ? { room: effectiveRoom, target: effectiveTarget, key, id: res.id }
          : undefined;
      setBusy(false);
      if (!res.ok) setError(errorMessage(res.error));
      return res.ok;
    },
    [room, target],
  );

  return { busy, error, run };
}
