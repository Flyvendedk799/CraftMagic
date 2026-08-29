import { describe, expect, it } from 'vitest';
import { AxisScale, blockBudget, isSizeChoice, SIZE_OPTIONS } from './scale.js';

/**
 * How far off perfect symmetry an axis is allowed to be.
 *
 * Zero, except for the one case arithmetic forbids: an axis an even number of blocks long
 * scaled to an odd number of blocks has a middle boundary that would have to land on half a
 * block to mirror itself. There the two halves differ by one block and nothing can be done
 * about it. Every other pairing is exact, which is the point of the test.
 */
function slack(base: number, target: number): number {
	return base % 2 === 0 && target % 2 === 1 ? 1 : 0;
}

/**
 * How far off perfect symmetry a single block is allowed to be.
 *
 * Three cases, all of them arithmetic rather than sloppiness, and all of them one block:
 *
 *  - the middle boundary of an even axis, as above;
 *  - a block that is its *own* mirror image — the middle of an odd axis — scaled onto an axis
 *    an even number of blocks long, which has no middle block for it to sit on;
 *  - a block whose cell a shrink has squeezed to nothing, which is drawn anyway because losing
 *    it outright is worse than crowding it.
 */
function blockSlack(scale: AxisScale, p: number, radius = 0): number {
	const { base, target } = scale;
	if (2 * p + 1 === base && target % 2 === 0) return 1;
	if (scale.edge(p + radius + 1) - 1 < scale.edge(p - radius)) return 1;
	return slack(base, target);
}

/** Every base/target pair worth worrying about: growing, shrinking, odd, even, extreme. */
const PAIRS: [number, number][] = [
	[1, 1],
	[2, 5],
	[5, 2],
	[9, 9],
	[9, 18],
	[9, 4],
	[20, 10],
	[20, 13],
	[21, 11],
	[21, 42],
	[13, 7],
	[33, 8],
	[16, 64],
	[100, 25],
];

describe('AxisScale — the edge map', () => {
	it('pins both ends of the axis exactly', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			expect(scale.edge(0), `${base}->${target}`).toBe(0);
			expect(scale.edge(base), `${base}->${target}`).toBe(target);
		}
	});

	it('is a mirror of itself, so symmetric geometry scales symmetrically', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			for (let k = 0; k <= base; k++) {
				const drift = Math.abs(scale.edge(base - k) - (target - scale.edge(k)));
				expect(drift, `${base}->${target} at ${k}`).toBeLessThanOrEqual(slack(base, target));
			}
		}
	});

	it('is exactly symmetric wherever a whole-block answer exists', () => {
		// Both ends and everything but the one middle boundary of an even-to-odd axis.
		for (const [base, target] of PAIRS) {
			if (slack(base, target) === 0) continue;
			const scale = new AxisScale(base, target);
			for (let k = 0; k <= base; k++) {
				if (2 * k === base) continue;
				expect(scale.edge(base - k), `${base}->${target} at ${k}`).toBe(target - scale.edge(k));
			}
		}
	});

	it('never goes backwards, so a run can never come out inside out', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			for (let k = 0; k < base; k++) {
				expect(scale.edge(k + 1), `${base}->${target} at ${k}`).toBeGreaterThanOrEqual(scale.edge(k));
			}
		}
	});

	it('leaves everything alone at 100%', () => {
		const scale = new AxisScale(17, 17);
		for (let p = 0; p < 17; p++) {
			expect(scale.point(p)).toBe(p);
			expect(scale.edge(p)).toBe(p);
			expect(scale.span(p, 3)).toEqual({ pos: p, len: 3 });
		}
	});
});

describe('AxisScale — runs', () => {
	it('hands neighbouring runs neighbouring cells, with no gap and no overlap', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			for (let p = 0; p + 2 <= base; p++) {
				const first = scale.span(p, 1);
				const second = scale.span(p + 1, 1);
				expect(first.pos + first.len, `${base}->${target} at ${p}`).toBe(second.pos);
			}
		}
	});

	it('gives a run and its mirror image the same length and mirrored positions', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			for (let p = 0; p < base; p++) {
				for (const len of [1, 2, 3]) {
					if (p + len > base) continue;
					const run = scale.span(p, len);
					const mirror = scale.span(base - p - len, len);
					const tolerance = slack(base, target);
					expect(
						Math.abs(mirror.len - run.len),
						`${base}->${target} run ${p}+${len}`,
					).toBeLessThanOrEqual(tolerance);
					expect(
						Math.abs(mirror.pos - (target - run.pos - run.len)),
						`${base}->${target} run ${p}+${len}`,
					).toBeLessThanOrEqual(tolerance);
				}
			}
		}
	});

	it('keeps a run that ended flush with the far edge flush with it', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			const run = scale.span(0, base);
			expect({ ...run }, `${base}->${target}`).toEqual({ pos: 0, len: target });
		}
	});
});

describe('AxisScale — single blocks', () => {
	it('places a block and its mirror on mirrored blocks', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			for (let p = 0; p < base; p++) {
				const drift = Math.abs(scale.point(base - 1 - p) - (target - 1 - scale.point(p)));
				expect(drift, `${base}->${target} at ${p}`).toBeLessThanOrEqual(blockSlack(scale, p));
			}
		}
	});

	it('keeps a block inside the volume even below half scale', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			for (let p = 0; p < base; p++) {
				expect(scale.point(p), `${base}->${target} at ${p}`).toBeGreaterThanOrEqual(0);
				expect(scale.point(p), `${base}->${target} at ${p}`).toBeLessThan(target);
			}
		}
	});

	it('puts a block inside the cells its own run covers', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			for (let p = 0; p < base; p++) {
				const run = scale.span(p, 1);
				if (run.len === 0) continue;
				expect(scale.point(p), `${base}->${target} at ${p}`).toBeGreaterThanOrEqual(run.pos);
				expect(scale.point(p), `${base}->${target} at ${p}`).toBeLessThan(run.pos + run.len);
			}
		}
	});
});

describe('AxisScale — centred runs', () => {
	it('mirrors a circle to a circle of the same radius', () => {
		for (const [base, target] of PAIRS) {
			const scale = new AxisScale(base, target);
			for (let p = 0; p < base; p++) {
				for (const radius of [0, 1, 3]) {
					const near = scale.centred(p, radius);
					const far = scale.centred(base - 1 - p, radius);
					const tolerance = blockSlack(scale, p, radius);
					expect(
						Math.abs(far.radius - near.radius),
						`${base}->${target} r${radius} at ${p}`,
					).toBeLessThanOrEqual(tolerance);
					expect(
						Math.abs(far.centre - (target - 1 - near.centre)),
						`${base}->${target} r${radius} at ${p}`,
					).toBeLessThanOrEqual(tolerance);
				}
			}
		}
	});

	it('takes the radius from the diameter, so a circle keeps the ground it covered', () => {
		// A radius-3 circle is 7 blocks across; at double size it covers 14, so radius 6 (13
		// across) is as close as an odd diameter gets — and never 7, which would be 15.
		const scale = new AxisScale(20, 40);
		expect(scale.centred(10, 3).radius).toBe(6);
	});

	it('holds every axis of a sphere to one radius when asked', () => {
		const scale = new AxisScale(20, 40);
		expect(scale.centred(10, 3, 2).radius).toBe(2);
	});
});

describe('AxisScale — free lengths and offsets', () => {
	it('never lets structure round away to nothing', () => {
		const scale = new AxisScale(100, 25);
		expect(scale.length(1)).toBe(1);
		// Trim asks for the other answer, and gets it.
		expect(scale.length(1, 0)).toBe(0);
	});

	it('passes nothing and nonsense through untouched', () => {
		const scale = new AxisScale(10, 20);
		expect(scale.length(0)).toBe(0);
		expect(scale.length(-3)).toBe(-3);
	});

	it('scales a distance the same either way round', () => {
		const scale = new AxisScale(9, 4);
		expect(scale.offset(-5)).toBe(-scale.offset(5));
	});
});

describe('size choices', () => {
	it('gives every choice but the natural one a block budget', () => {
		for (const option of SIZE_OPTIONS) {
			expect(blockBudget(option.id)).toBe(option.blocks);
			expect(isSizeChoice(option.id)).toBe(true);
		}
		expect(blockBudget('natural')).toBeNull();
	});

	it('rejects anything that is not one', () => {
		expect(isSizeChoice('enormous')).toBe(false);
		expect(isSizeChoice(32)).toBe(false);
		expect(blockBudget(undefined)).toBeNull();
	});
});
