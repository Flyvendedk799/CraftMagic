/**
 * Ctrl+Z, once, for all three modes.
 *
 * This was written three times with three behaviours. Build had it inside its session hook with
 * Ctrl+Y and a `contentEditable`-aware guard; Architecture had a byte-identical copy of that
 * guard in its page plus a suppression while the shortcut sheet is open; World had it in its page
 * with no Ctrl+Y at all and a guard that tested `tagName` only — so typing into the world's name
 * field was safe, but typing into anything rich was not, and the Windows-native redo key did
 * nothing in one mode out of three.
 *
 * A shortcut that works differently depending on which pill is lit is not a shortcut, it is a
 * thing to find out about. So there is one implementation, and the differences that remain are
 * passed in.
 */

import { useEffect } from 'react';

/**
 * Whether a key event is somebody typing.
 *
 * `contentEditable` matters and is easy to forget: a rich-text field is neither an `INPUT` nor a
 * `TEXTAREA`, so a `tagName` check silently lets Ctrl+Z through to the document and undoes a
 * building instead of a word.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface UndoKeyOptions {
  undo: () => void;
  redo: () => void;
  /**
   * Suppress the binding entirely — a modal is open, or the document is not ready to be edited.
   *
   * Architecture uses this for its shortcut sheet. The alternative, letting the dialog swallow
   * the key, only works while the dialog holds focus, and this one does not.
   */
  disabled?: boolean;
}

/**
 * Bind undo and redo on the window.
 *
 * All three spellings, because all three are in people's fingers: Ctrl+Z undoes, Ctrl+Shift+Z
 * redoes (the Mac-and-web convention) and Ctrl+Y redoes (the Windows-native one). `preventDefault`
 * on every one of them, or the browser's own undo runs as well and edits a text field somewhere
 * off screen.
 */
export function useUndoKeys({ undo, redo, disabled = false }: UndoKeyOptions): void {
  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (isTextEntry(event.target)) return;

      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === 'y' && !event.shiftKey) {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, disabled]);
}
