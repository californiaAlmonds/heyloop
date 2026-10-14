import { useCallback, useRef, useState } from 'react';
import { client, type OutgoingFrame } from './client';
import { errorMessage } from './format';

/** Runs one user action at a time; retrying the same `key` after 'unconfirmed' reuses the frame id. */
export function useAction() {
  const attempt = useRef<{ key: string; id: string }>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = useCallback(async (key: string, frame: OutgoingFrame): Promise<boolean> => {
    const prev = attempt.current;
    if (prev && prev.key !== key) client.discard(prev.id);
    setBusy(true);
    setError(undefined);
    const res = await client.submit(frame, prev?.key === key ? prev.id : undefined);
    attempt.current = res.error === 'unconfirmed' ? { key, id: res.id } : undefined;
    setBusy(false);
    if (!res.ok) setError(errorMessage(res.error));
    return res.ok;
  }, []);

  return { busy, error, run };
}
