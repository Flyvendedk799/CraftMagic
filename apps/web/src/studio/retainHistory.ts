/**
 * Undo stacks that outlive the page that draws them.
 *
 * The studio mounts one mode at a time, so a pill switch unmounts the page and every
 * `useRef` history dies with it. The document comes back from autosave; the undo stack did
 * not, which is why Ctrl+Z after a round trip did nothing. The stacks live here, keyed by
 * the document, and a remount asks for the same one.
 */

import { EditHistory } from '../editor/history.js';
import { PlanHistory } from '../architecture/history.js';
import { WorldHistory } from '../world/history.js';

const edits = new Map<string, EditHistory>();
const plans = new Map<string, PlanHistory>();
const worlds = new Map<string, WorldHistory>();

export function editHistoryFor(id: string): EditHistory {
  let history = edits.get(id);
  if (!history) {
    history = new EditHistory();
    edits.set(id, history);
  }
  return history;
}

export function planHistoryFor(id: string): PlanHistory {
  let history = plans.get(id);
  if (!history) {
    history = new PlanHistory();
    plans.set(id, history);
  }
  return history;
}

export function worldHistoryFor(id: string): WorldHistory {
  let history = worlds.get(id);
  if (!history) {
    history = new WorldHistory();
    worlds.set(id, history);
  }
  return history;
}
