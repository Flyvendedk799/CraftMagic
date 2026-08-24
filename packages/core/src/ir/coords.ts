/**
 * Coordinate expressions.
 *
 * Anchors (`min`/`max`/`center`/`%`) and params are what make a program survive a resize:
 * a wall written as `"max-1"` stays on the wall when the structure grows, where a literal
 * `19` would end up floating in the middle of it.
 *
 * The grammar is a small arithmetic language rather than a fixed pattern. That is a
 * deliberate widening: the first real generation run produced `"$towerHeight*30%"` and
 * `"$towerHeight-2+$sailLength"` — both entirely reasonable ways to say what the model
 * meant, both rejected by the original single-offset grammar, and each rejection cost a
 * paid repair round.
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor ('*' factor)*
 *   factor := '-'? atom
 *   atom   := INT | INT '%' | 'min' | 'max' | 'center' | '$' NAME | '(' expr ')'
 *
 * Percentages read the way people write them in both positions:
 *   "50%"                → half of the axis span
 *   "$height*30%"        → 30% of $height
 * A percentage standing alone is a share of the axis; used as a multiplier it is a plain
 * fraction. Anything else would make one of those two spellings surprising.
 */

import type { Coord, ProgramParam } from './types.js';

export class CoordError extends Error {
	constructor(
		message: string,
		/** The offending expression, as written — a number is legal input too. */
		readonly expr: Coord,
	) {
		super(message);
		this.name = 'CoordError';
	}
}

export interface CoordContext {
	/** Length of the axis being resolved, in blocks. */
	extent: number;
	params?: Record<string, ProgramParam>;
}

/** A value plus whether it is still an unscaled percentage. */
interface Value {
	n: number;
	percent: boolean;
}

type Token =
	| { kind: 'number'; value: number; percent: boolean }
	| { kind: 'anchor'; value: 'min' | 'max' | 'center' }
	| { kind: 'param'; name: string }
	| { kind: 'op'; value: '+' | '-' | '*' | '/' }
	| { kind: 'paren'; value: '(' | ')' };

function tokenize(expr: string, source: Coord): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < expr.length) {
		const ch = expr[i]!;

		if (ch === ' ') {
			i++;
			continue;
		}

		if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
			tokens.push({ kind: 'op', value: ch });
			i++;
			continue;
		}

		if (ch === '(' || ch === ')') {
			tokens.push({ kind: 'paren', value: ch });
			i++;
			continue;
		}

		// Decimals are accepted because models write them: a real run produced "max*0.42".
		if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(expr[i + 1] ?? ''))) {
			let j = i;
			while (j < expr.length && /[0-9]/.test(expr[j]!)) j++;
			if (expr[j] === '.') {
				j++;
				while (j < expr.length && /[0-9]/.test(expr[j]!)) j++;
			}
			const value = Number.parseFloat(expr.slice(i, j));
			if (expr[j] === '%') {
				tokens.push({ kind: 'number', value, percent: true });
				j++;
			} else {
				tokens.push({ kind: 'number', value, percent: false });
			}
			i = j;
			continue;
		}

		if (ch === '$') {
			let j = i + 1;
			while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j]!)) j++;
			if (j === i + 1) throw new CoordError(`"$" must be followed by a param name in "${expr}"`, source);
			tokens.push({ kind: 'param', name: expr.slice(i + 1, j) });
			i = j;
			continue;
		}

		if (/[a-z]/i.test(ch)) {
			let j = i;
			while (j < expr.length && /[a-z]/i.test(expr[j]!)) j++;
			const word = expr.slice(i, j).toLowerCase();
			if (word !== 'min' && word !== 'max' && word !== 'center') {
				throw new CoordError(
					`unknown word "${word}" in "${expr}" — expected min, max, center, a number, a percentage like "50%", or "$param"`,
					source,
				);
			}
			tokens.push({ kind: 'anchor', value: word });
			i = j;
			continue;
		}

		throw new CoordError(`unexpected character "${ch}" in "${expr}"`, source);
	}

	return tokens;
}

class Parser {
	private pos = 0;

	constructor(
		private readonly tokens: Token[],
		private readonly ctx: CoordContext,
		private readonly source: Coord,
	) {}

	parse(): number {
		const value = this.expr();
		if (this.pos < this.tokens.length) {
			throw new CoordError(`unexpected trailing input in "${String(this.source).trim()}"`, this.source);
		}
		return Math.round(this.scale(value));
	}

	/** Turn a still-unscaled percentage into a position on this axis. */
	private scale(value: Value): number {
		return value.percent ? (value.n / 100) * (this.ctx.extent - 1) : value.n;
	}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private expr(): Value {
		let left = this.term();
		for (;;) {
			const token = this.peek();
			if (token?.kind !== 'op' || (token.value !== '+' && token.value !== '-')) break;
			this.pos++;
			const right = this.term();
			// Addition mixes positions, so any lingering percentage resolves to the axis here.
			const sum = this.scale(left) + (token.value === '+' ? this.scale(right) : -this.scale(right));
			left = { n: sum, percent: false };
		}
		return left;
	}

	private term(): Value {
		let left = this.factor();
		for (;;) {
			const token = this.peek();
			if (token?.kind !== 'op' || (token.value !== '*' && token.value !== '/')) break;
			this.pos++;
			const right = this.factor();
			// A percentage as a multiplier is a plain fraction: "$height*30%" is 30% of
			// $height, not 30% of the axis.
			const l = left.percent && !right.percent ? left.n / 100 : this.scaleIfBothConcrete(left, right, 'left');
			const r = right.percent && !left.percent ? right.n / 100 : this.scaleIfBothConcrete(left, right, 'right');
			if (token.value === '/' && r === 0) {
				throw new CoordError(`division by zero in "${String(this.source).trim()}"`, this.source);
			}
			left = { n: token.value === '*' ? l * r : l / r, percent: false };
		}
		return left;
	}

	private scaleIfBothConcrete(left: Value, right: Value, side: 'left' | 'right'): number {
		const value = side === 'left' ? left : right;
		// Two percentages multiplied together are both fractions.
		if (value.percent) return left.percent && right.percent ? value.n / 100 : this.scale(value);
		return value.n;
	}

	private factor(): Value {
		const token = this.peek();
		if (token?.kind === 'op' && token.value === '-') {
			this.pos++;
			const inner = this.factor();
			return { n: -this.scale(inner), percent: false };
		}
		return this.atom();
	}

	private atom(): Value {
		const token = this.peek();
		if (!token) {
			throw new CoordError(`"${String(this.source).trim()}" ends unexpectedly`, this.source);
		}
		this.pos++;

		switch (token.kind) {
			case 'number':
				return { n: token.value, percent: token.percent };

			case 'anchor': {
				const maxIndex = this.ctx.extent - 1;
				if (token.value === 'min') return { n: 0, percent: false };
				if (token.value === 'max') return { n: maxIndex, percent: false };
				return { n: Math.floor(maxIndex / 2), percent: false };
			}

			case 'param': {
				const param = this.ctx.params?.[token.name];
				if (param === undefined) {
					const known = Object.keys(this.ctx.params ?? {});
					throw new CoordError(
						`unknown param "$${token.name}"` +
							(known.length
								? ` — declared params are ${known.map((k) => `$${k}`).join(', ')}`
								: ' — no params are declared'),
						this.source,
					);
				}
				return { n: clampParam(param), percent: false };
			}

			case 'paren': {
				if (token.value !== '(') {
					throw new CoordError(`unexpected ")" in "${String(this.source).trim()}"`, this.source);
				}
				const inner = this.expr();
				const close = this.peek();
				if (close?.kind !== 'paren' || close.value !== ')') {
					throw new CoordError(`missing ")" in "${String(this.source).trim()}"`, this.source);
				}
				this.pos++;
				return inner;
			}

			case 'op':
				throw new CoordError(
					`unexpected "${token.value}" in "${String(this.source).trim()}"`,
					this.source,
				);
		}
	}
}

/**
 * Resolve a coordinate expression to an integer block position.
 * Throws `CoordError`; callers turn that into an `ExpandIssue` with a path so the model can
 * repair it.
 */
export function resolveCoord(coord: Coord, ctx: CoordContext): number {
	if (typeof coord === 'number') {
		if (!Number.isFinite(coord)) throw new CoordError('coordinate is not a finite number', String(coord));
		return Math.round(coord);
	}

	const expr = coord.trim();
	if (expr === '') throw new CoordError('empty coordinate expression', coord);

	const tokens = tokenize(expr, coord);
	if (tokens.length === 0) throw new CoordError('empty coordinate expression', coord);

	return new Parser(tokens, ctx, coord).parse();
}

/** Params are clamped to their declared range so a stale slider value can't escape it. */
export function clampParam(param: ProgramParam): number {
	return Math.round(Math.min(param.max, Math.max(param.min, param.value)));
}

/** Resolve a triple against per-axis extents. */
export function resolveVec3(
	coords: readonly [Coord, Coord, Coord],
	size: { x: number; y: number; z: number },
	params?: Record<string, ProgramParam>,
): [number, number, number] {
	return [
		resolveCoord(coords[0], { extent: size.x, params }),
		resolveCoord(coords[1], { extent: size.y, params }),
		resolveCoord(coords[2], { extent: size.z, params }),
	];
}

/**
 * Resolve a triple used as a *size* rather than a position. Sizes are lengths, so the
 * span is `extent` rather than `extent - 1`, and a resolved size is clamped to at least 0.
 */
export function resolveSize3(
	coords: readonly [Coord, Coord, Coord],
	size: { x: number; y: number; z: number },
	params?: Record<string, ProgramParam>,
): [number, number, number] {
	const axes = [size.x, size.y, size.z] as const;
	return [0, 1, 2].map((i) => {
		const raw = resolveCoord(coords[i]!, { extent: axes[i]! + 1, params });
		return Math.max(0, raw);
	}) as [number, number, number];
}
