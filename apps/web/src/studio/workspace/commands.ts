export interface SearchableCommand {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  category?: string;
}
/** Word-prefix matches rank above substrings; every word must match. Stable ties preserve author order. */
export function rankCommands<T extends SearchableCommand>(
  commands: readonly T[],
  query: string,
  recent: readonly string[] = [],
): T[] {
  const words = query
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const ranked = commands
    .map((command, index) => {
      const label = command.label.toLowerCase(),
        haystack =
          `${label} ${command.hint ?? ''} ${command.keywords ?? ''} ${command.category ?? ''}`
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return null;
      const score =
        words.reduce(
          (sum, word) =>
            sum +
            (label === word
              ? 100
              : label.startsWith(word)
                ? 30
                : label.split(/\W+/).some((part) => part.startsWith(word))
                  ? 15
                  : label.includes(word)
                    ? 8
                    : 1),
          0,
        ) +
        (!words.length && recent.includes(command.id)
          ? 20 - Math.min(recent.indexOf(command.id), 19)
          : 0);
      return { command, score, index };
    })
    .filter(
      (v): v is { command: T; score: number; index: number } => v !== null,
    );
  return ranked
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((v) => v.command);
}
export function nextCursor(
  current: number,
  by: number,
  length: number,
): number {
  return length ? (current + by + length) % length : 0;
}
