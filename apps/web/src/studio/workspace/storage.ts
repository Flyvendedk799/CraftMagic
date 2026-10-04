import { useCallback, useRef, useState, type SetStateAction } from 'react';
/** Local metadata only; quota failures stay visible and never prevent editing. */
export function useStoredState<T>(
  key: string,
  read: (raw: string | null) => T,
): [T, (next: SetStateAction<T>) => void, string | null] {
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<T>(() => {
    try {
      return read(localStorage.getItem(key));
    } catch {
      return read(null);
    }
  });
  const current = useRef(value);
  const update = useCallback(
    (next: SetStateAction<T>) => {
      const result =
        typeof next === 'function'
          ? (next as (v: T) => T)(current.current)
          : next;
      current.current = result;
      setValue(result);
      try {
        localStorage.setItem(key, JSON.stringify(result));
        setError(null);
      } catch {
        setError(
          'Workspace preferences could not be saved on this device. Editing still works.',
        );
      }
    },
    [key],
  );
  return [value, update, error];
}
