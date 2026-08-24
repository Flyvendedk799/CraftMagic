/**
 * Password hashing.
 *
 * Its own module so that "what protects the passwords" is one readable place rather than a
 * parameter buried in a route handler — and so the choice can be tested rather than taken on
 * trust.
 *
 * argon2id at the library's defaults: 64 MiB, 3 passes, 4 lanes. argon2id is the variant to
 * use unless there is a specific reason otherwise — argon2i alone is weaker against
 * time-memory tradeoffs, argon2d alone leaks through cache timing — and 64 MiB clears the
 * OWASP minimum for it with room to spare. The memory cost is what makes a GPU farm expensive;
 * raising the iteration count instead would buy far less per millisecond spent.
 *
 * `verify` reads the parameters back out of the stored string, so raising these later
 * re-secures new passwords without invalidating a single existing one.
 */

import argon2 from 'argon2';

const OPTIONS = { type: argon2.argon2id } as const;

/**
 * Length is the only rule.
 *
 * A composition rule ("one digit, one symbol") measurably pushes people towards `Password1!`
 * and buys nothing against an offline attack on argon2id, where the defence is the cost of a
 * guess rather than the shape of the answer.
 */
export const MIN_PASSWORD = 10;
/** Bounded so a megabyte of "password" cannot be turned into a memory-hard DoS. */
export const MAX_PASSWORD = 200;

export function isAcceptablePassword(password: string): boolean {
	return password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD;
}

export function hashPassword(password: string): Promise<string> {
	return argon2.hash(password, OPTIONS);
}

/** False rather than throwing on a malformed or foreign hash — a bad row is a failed login. */
export function verifyPassword(hash: string, password: string): Promise<boolean> {
	return argon2.verify(hash, password).catch(() => false);
}

/**
 * A real argon2id hash of a value nobody knows, to verify against when the email is unknown.
 *
 * Without it, "no such user" returns in microseconds while "wrong password" takes tens of
 * milliseconds, and that difference is a working account-enumeration oracle over the network.
 * Computed once and reused: the cost that matters is the verify, not the hash.
 */
let dummy: Promise<string> | null = null;

export async function burnVerifyTime(password: string): Promise<false> {
	dummy ??= hashPassword('imaginecraft-timing-equaliser');
	await verifyPassword(await dummy, password);
	return false;
}
