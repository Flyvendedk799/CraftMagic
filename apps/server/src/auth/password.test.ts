import { describe, expect, it } from 'vitest';
import {
	burnVerifyTime,
	hashPassword,
	isAcceptablePassword,
	MAX_PASSWORD,
	MIN_PASSWORD,
	verifyPassword,
} from './password.js';

describe('password hashing', () => {
	it('is argon2id, at parameters that clear the OWASP minimum', async () => {
		const hash = await hashPassword('correct-horse-battery');
		// The encoded string carries the algorithm and its cost parameters, which is what lets
		// them be raised later without invalidating existing hashes — and what lets this assert
		// the choice rather than assume it.
		expect(hash).toMatch(/^\$argon2id\$/);

		const memory = /m=(\d+)/.exec(hash);
		const passes = /t=(\d+)/.exec(hash);
		expect(Number(memory?.[1])).toBeGreaterThanOrEqual(19 * 1024);
		expect(Number(passes?.[1])).toBeGreaterThanOrEqual(2);
	});

	it('verifies the right password and rejects the wrong one', async () => {
		const hash = await hashPassword('correct-horse-battery');
		expect(await verifyPassword(hash, 'correct-horse-battery')).toBe(true);
		expect(await verifyPassword(hash, 'correct-horse-batterz')).toBe(false);
		expect(await verifyPassword(hash, '')).toBe(false);
	});

	it('never stores the password', async () => {
		const password = 'a-very-memorable-passphrase';
		const hash = await hashPassword(password);
		expect(hash).not.toContain(password);
		// Nor any recognisable run of it — a hash that embedded a prefix would still pass the
		// check above.
		expect(hash).not.toContain(password.slice(0, 8));
	});

	it('salts, so the same password twice gives two different hashes', async () => {
		const [a, b] = await Promise.all([hashPassword('same-password-twice'), hashPassword('same-password-twice')]);
		expect(a).not.toEqual(b);
		// Both still verify: the salt lives in the encoded string, not in a separate column.
		expect(await verifyPassword(a, 'same-password-twice')).toBe(true);
		expect(await verifyPassword(b, 'same-password-twice')).toBe(true);
	});

	it('returns false rather than throwing on a hash it cannot parse', async () => {
		// A corrupt or foreign row must be a failed login, not a 500 that takes out the route.
		expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
		expect(await verifyPassword('', 'anything')).toBe(false);
	});

	it('bounds password length at both ends', () => {
		expect(isAcceptablePassword('x'.repeat(MIN_PASSWORD - 1))).toBe(false);
		expect(isAcceptablePassword('x'.repeat(MIN_PASSWORD))).toBe(true);
		expect(isAcceptablePassword('x'.repeat(MAX_PASSWORD))).toBe(true);
		// Unbounded input into a deliberately memory-hard function is a DoS, not a feature.
		expect(isAcceptablePassword('x'.repeat(MAX_PASSWORD + 1))).toBe(false);
	});

	it('burns comparable time for an unknown account', async () => {
		const hash = await hashPassword('a-real-users-password');

		// Warm both paths first: the dummy hash is computed once and the first argon2 call in a
		// process pays for the native module's setup, either of which would swamp the signal.
		await verifyPassword(hash, 'wrong');
		await burnVerifyTime('wrong');

		const realStart = performance.now();
		await verifyPassword(hash, 'wrong');
		const real = performance.now() - realStart;

		const dummyStart = performance.now();
		await burnVerifyTime('wrong');
		const dummy = performance.now() - dummyStart;

		expect(await burnVerifyTime('wrong')).toBe(false);
		// Deliberately loose. The property that matters is "same order of magnitude, so the
		// difference is not an enumeration oracle", not a precise ratio that would make this
		// test flaky on a busy machine.
		expect(dummy).toBeGreaterThan(real / 5);
	});
});
