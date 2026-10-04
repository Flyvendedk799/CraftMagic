import { describe, it, expect } from 'vitest';
import { rankCommands, nextCursor } from './commands.js';
const commands = [
  { id: 'a', label: 'Save document', hint: 'Save to your account' },
  { id: 'b', label: 'Tools: Erase', category: 'Tools', hint: 'Remove blocks' },
  { id: 'c', label: 'View: Front', category: 'View' },
];
describe('command search', () => {
  it('requires every word in any order', () =>
    expect(rankCommands(commands, 'blocks remove').map((v) => v.id)).toEqual([
      'b',
    ]));
  it('searches categories and keywords', () =>
    expect(rankCommands(commands, 'view')[0]!.id).toBe('c'));
  it('ranks recent actions only for an empty query', () => {
    expect(rankCommands(commands, '', ['c'])[0]!.id).toBe('c');
    expect(rankCommands(commands, 'save', ['c'])[0]!.id).toBe('a');
  });
  it('handles diacritics', () =>
    expect(rankCommands([{ id: 'x', label: 'Café' }], 'cafe')).toHaveLength(1));
  it('wraps keyboard navigation and handles empty results', () => {
    expect(nextCursor(0, -1, 3)).toBe(2);
    expect(nextCursor(2, 1, 3)).toBe(0);
    expect(nextCursor(0, -1, 0)).toBe(0);
  });
  it('preserves author order for ties', () =>
    expect(rankCommands(commands, '').map((v) => v.id)).toEqual([
      'a',
      'b',
      'c',
    ]));
});
