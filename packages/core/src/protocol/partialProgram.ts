/**
 * Read a build program out of an *unfinished* JSON stream.
 *
 * While the model is still emitting, the accumulated tool-call JSON is a prefix: valid up to
 * some point, then cut mid-token. This module completes that prefix into a parseable program
 * whose `components` are only the fully-closed ones — which is what lets a 3D preview
 * assemble live during generation instead of a spinner.
 *
 * It leans on a fact the system prompt enforces: top-level keys arrive in a fixed order,
 * `version, meta, size, palette, components` — so by the time the first component streams,
 * `size` and `palette` are complete. The scanner only has to find the `components` array,
 * remember every position where a component object just closed, cut there, and append the
 * two brackets that close the array and the root object. Anything after `components`
 * (`details`, usually) is deliberately dropped from the preview.
 *
 * Deterministic, allocation-light, and — critically — *safe to be wrong*: a `null` return
 * means "no preview yet", never a failed generation. The paid response is parsed for real by
 * the pipeline once it is complete.
 */

import type { BuildProgram } from '../ir/types.js';

export interface PartialProgram {
	program: BuildProgram;
	/** Fully-closed components in the preview — the honest progress number. */
	components: number;
}

export function partialProgram(prefix: string): PartialProgram | null {
	const cut = scan(prefix);
	if (cut === null) return null;

	const candidate = `${prefix.slice(0, cut.end)}${cut.close}`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}

	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('size' in parsed) ||
		!('palette' in parsed) ||
		!Array.isArray((parsed as { components?: unknown }).components)
	) {
		return null;
	}

	const program = parsed as BuildProgram;
	return { program, components: program.components.length };
}

interface Cut {
	/** Slice the prefix here… */
	end: number;
	/** …and append this to make it parse. */
	close: string;
}

/**
 * One pass over the prefix, tracking string/escape state and bracket depth.
 *
 * Two kinds of cut are recorded: right after a component object closes (depth back to the
 * components array), and right after the `palette` object closes (so a preview with zero
 * components — grid size and ground plane — exists as soon as the header has streamed).
 */
function scan(prefix: string): Cut | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	/** The most recent complete string at depth 1 — i.e. the pending top-level key. */
	let key = '';
	let keyStart = -1;
	let inComponents = false;
	let componentCut: Cut | null = null;
	let paletteCut: Cut | null = null;

	for (let i = 0; i < prefix.length; i++) {
		const ch = prefix[i]!;

		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') {
				inString = false;
				if (depth === 1 && keyStart >= 0) key = prefix.slice(keyStart, i);
			}
			continue;
		}

		switch (ch) {
			case '"':
				inString = true;
				if (depth === 1) keyStart = i + 1;
				break;
			case '{':
			case '[':
				if (ch === '[' && depth === 1 && key === 'components') inComponents = true;
				depth++;
				break;
			case '}':
			case ']':
				depth--;
				if (ch === ']' && depth === 1 && inComponents) {
					// The whole array closed cleanly — everything in it is complete.
					componentCut = { end: i + 1, close: '}' };
					inComponents = false;
				} else if (ch === '}' && depth === 2 && inComponents) {
					// A component object just closed; the array and root are still open.
					componentCut = { end: i + 1, close: ']}' };
				} else if (ch === '}' && depth === 1 && key === 'palette') {
					paletteCut = { end: i + 1, close: ',"components":[]}' };
				}
				if (depth < 0) return null; // Malformed beyond repair; wait for more input.
				break;
		}
	}

	return componentCut ?? paletteCut;
}
