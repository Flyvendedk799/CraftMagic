/**
 * End-to-end test of accounts and ownership, against a running server.
 *
 * Node's fetch does not keep a cookie jar, which is exactly what this needs: every request
 * states which session it is using, so "two users cannot see each other's builds" is checked
 * by sending user A's cookie to a route and looking at user B's data — not by hoping an
 * implicit jar held the right value.
 *
 * The expired-session check inserts a row directly with a known token digest. There is no
 * endpoint that can produce one, and adding a debug route to create it would mean shipping a
 * way to mint sessions with arbitrary expiry — which is a worse thing to have than a test
 * that needs psql.
 *
 *   node tools/verify-auth.mjs
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand, samples } from '@imaginecraft/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const ORIGIN = process.env.IC_ORIGIN ?? 'http://localhost:3016';

const envFile = path.join(repoRoot, 'apps/server/.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

let failures = 0;
function check(label, ok, detail = '') {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

/**
 * One request. `cookie` is passed explicitly rather than accumulated, so a test can never
 * pass because a previous one happened to leave the right session lying around.
 */
async function call(method, url, { body, cookie, headers } = {}) {
	const response = await fetch(`${ORIGIN}${url}`, {
		method,
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...(cookie ? { Cookie: cookie } : {}),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

	const text = await response.text();
	let parsed;
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		parsed = { raw: text };
	}

	return {
		status: response.status,
		body: parsed,
		setCookie: response.headers.getSetCookie?.() ?? [],
	};
}

/** The `ic_session=...` pair out of a Set-Cookie, ready to send back. */
function sessionCookie(setCookie) {
	const header = setCookie.find((c) => c.startsWith('ic_session='));
	return header ? header.split(';')[0] : null;
}

function psql(sql) {
	const bin = path.join(process.env.USERPROFILE ?? '', 'tools/pgsql/bin/psql.exe');
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set — read apps/server/.env');
	return execFileSync(bin, [url, '-tAc', sql], { encoding: 'utf8' }).trim();
}

console.log(`target: ${ORIGIN}\n`);

// Unique per run, so the suite is re-runnable without cleaning the database first.
const stamp = Date.now();
const alice = { email: `alice-${stamp}@example.test`, password: 'correct-horse-battery' };
const bob = { email: `bob-${stamp}@example.test`, password: 'another-long-password' };

// --- register -------------------------------------------------------------
console.log('register');

const badEmail = await call('POST', '/api/auth/register', { body: { email: 'nope', password: alice.password } });
check('a malformed email is rejected', badEmail.status === 400, badEmail.body.error);

const shortPassword = await call('POST', '/api/auth/register', { body: { email: alice.email, password: 'short' } });
check('a short password is rejected', shortPassword.status === 400, shortPassword.body.error);

const registered = await call('POST', '/api/auth/register', { body: alice });
check('register creates an account', registered.status === 201, registered.body.user?.email);
check('the reply carries the quota', registered.body.user?.dailyGenQuota === 30, String(registered.body.user?.dailyGenQuota));

const cookieHeader = registered.setCookie.find((c) => c.startsWith('ic_session='));
check('the session cookie is HttpOnly', /HttpOnly/i.test(cookieHeader ?? ''));
check('the session cookie is SameSite=Lax', /SameSite=Lax/i.test(cookieHeader ?? ''));
check('the session cookie is Path=/', /Path=\//i.test(cookieHeader ?? ''));
// This run is plain http, so Secure must be absent or the browser would drop the cookie.
check('no Secure over plain http', !/;\s*Secure/i.test(cookieHeader ?? ''), cookieHeader?.replace(/=[^;]+/, '=<redacted>'));

const aliceCookie = sessionCookie(registered.setCookie);
check('a session token came back', aliceCookie !== null);

const duplicate = await call('POST', '/api/auth/register', { body: alice });
check('a duplicate email is rejected', duplicate.status === 409, duplicate.body.error);

// --- login ----------------------------------------------------------------
console.log('\nlogin');

const wrongPassword = await call('POST', '/api/auth/login', {
	body: { email: alice.email, password: 'definitely-not-it' },
});
check('a wrong password is rejected', wrongPassword.status === 401, wrongPassword.body.error);
check('no cookie is issued on a failed login', sessionCookie(wrongPassword.setCookie) === null);

const unknownUser = await call('POST', '/api/auth/login', {
	body: { email: `nobody-${stamp}@example.test`, password: alice.password },
});
check('an unknown account gives the same answer', unknownUser.status === 401, unknownUser.body.error);
check(
	'the two failures are indistinguishable',
	unknownUser.body.message === wrongPassword.body.message,
	JSON.stringify(unknownUser.body.message),
);

const loggedIn = await call('POST', '/api/auth/login', { body: alice });
check('login succeeds with the right password', loggedIn.status === 200, loggedIn.body.user?.email);
const aliceSecondCookie = sessionCookie(loggedIn.setCookie);
check('login mints a second, different session', aliceSecondCookie !== null && aliceSecondCookie !== aliceCookie);

// --- /api/me --------------------------------------------------------------
console.log('\n/api/me');

const me = await call('GET', '/api/me', { cookie: aliceCookie });
check('/api/me works with the cookie', me.status === 200, me.body.user?.email);
check('/api/me reports the remaining quota', typeof me.body.user?.generationsLeftToday === 'number', String(me.body.user?.generationsLeftToday));

const anonymousMe = await call('GET', '/api/me');
check('/api/me 401s without a cookie', anonymousMe.status === 401, anonymousMe.body.error);

const garbageMe = await call('GET', '/api/me', { cookie: `ic_session=${randomBytes(32).toString('base64url')}` });
check('/api/me 401s on an invented token', garbageMe.status === 401);

// --- the origin guard -----------------------------------------------------
console.log('\ncross-site guard');

const crossSite = await call('POST', '/api/auth/login', {
	body: alice,
	headers: { Origin: 'https://evil.example' },
});
check('a foreign Origin is refused on a mutation', crossSite.status === 403, crossSite.body.error);

const sameOrigin = await call('POST', '/api/auth/login', {
	body: alice,
	headers: { Origin: ORIGIN },
});
check('the real Origin is accepted', sameOrigin.status === 200);

const crossSiteRead = await call('GET', '/api/me', {
	cookie: aliceCookie,
	headers: { Origin: 'https://evil.example' },
});
// Reads are not guarded here: SameSite=Lax already withholds the cookie cross-site, and a
// blanket check would break the mod, which sends no Origin at all.
check('reads are not blocked by the guard', crossSiteRead.status === 200);

// --- ownership: builds ----------------------------------------------------
console.log('\nownership — builds');

const registeredBob = await call('POST', '/api/auth/register', { body: bob });
check("bob's account is created", registeredBob.status === 201);
const bobCookie = sessionCookie(registeredBob.setCookie);

const { grid } = expand(samples.cottage);
const gridBody = { size: grid.size, palette: grid.palette, voxels: Array.from(grid.voxels) };

const aliceBuild = await call('POST', '/api/builds', {
	cookie: aliceCookie,
	body: { name: 'Alice Cottage', library: true, program: samples.cottage, grid: gridBody },
});
check("alice saves a build to her library", aliceBuild.status === 201, `id=${aliceBuild.body.id}`);

const bobBuild = await call('POST', '/api/builds', {
	cookie: bobCookie,
	body: { name: 'Bob Tower', library: true, program: samples.tower, grid: gridBody },
});
check("bob saves one too", bobBuild.status === 201, `id=${bobBuild.body.id}`);

const aliceList = await call('GET', '/api/builds', { cookie: aliceCookie });
const aliceNames = (aliceList.body.builds ?? []).map((b) => b.name);
check('alice sees exactly her own build', aliceNames.length === 1 && aliceNames[0] === 'Alice Cottage', aliceNames.join(', '));

const bobList = await call('GET', '/api/builds', { cookie: bobCookie });
const bobNames = (bobList.body.builds ?? []).map((b) => b.name);
check('bob sees exactly his own', bobNames.length === 1 && bobNames[0] === 'Bob Tower', bobNames.join(', '));

const anonymousList = await call('GET', '/api/builds');
check('a signed-out caller cannot list a library', anonymousList.status === 401, anonymousList.body.error);

const stealRead = await call('GET', `/api/builds/${bobBuild.body.id}`, { cookie: aliceCookie });
check("alice cannot read bob's build", stealRead.status === 404, `${stealRead.status} ${stealRead.body.error}`);

const stealRename = await call('PATCH', `/api/builds/${bobBuild.body.id}`, {
	cookie: aliceCookie,
	body: { name: 'Mine Now' },
});
check("alice cannot rename bob's build", stealRename.status === 404);

const stealDelete = await call('DELETE', `/api/builds/${bobBuild.body.id}`, { cookie: aliceCookie });
check("alice cannot delete bob's build", stealDelete.status === 404);

const bobStillThere = await call('GET', `/api/builds/${bobBuild.body.id}`, { cookie: bobCookie });
check("bob's build survived all three attempts", bobStillThere.status === 200 && bobStillThere.body.name === 'Bob Tower', bobStillThere.body.name);
check('the detail response carries voxels', Array.isArray(bobStillThere.body.grid?.voxels) && bobStillThere.body.grid.voxels.length > 0, `${bobStillThere.body.grid?.voxels?.length} cells`);
check('the detail response carries the program', bobStillThere.body.program?.version === 1);

const renamed = await call('PATCH', `/api/builds/${aliceBuild.body.id}`, {
	cookie: aliceCookie,
	body: { name: 'Renamed Cottage' },
});
check('the owner can rename', renamed.status === 200 && renamed.body.name === 'Renamed Cottage', renamed.body.name);

const anonymousSave = await call('POST', '/api/builds', {
	body: { name: 'Anon Library', library: true, grid: gridBody },
});
check('a signed-out caller cannot save to a library', anonymousSave.status === 401, anonymousSave.body.error);

// Nor without the library flag. Saving used to be open because "send to game" needed it;
// sending needs an account now, so an anonymous save would only write a row nobody could ever
// reach — unreachable state, and an unauthenticated way to push megabytes into the database.
const anonymousTransport = await call('POST', '/api/builds', {
	body: { name: 'Anon Transport', grid: gridBody },
});
check('a signed-out caller cannot save a build at all', anonymousTransport.status === 401, anonymousTransport.body.error);

// --- ownership: agents ----------------------------------------------------
console.log('\nownership — agents');

const aliceCode = await call('POST', '/api/agent/pair-codes', { cookie: aliceCookie });
check('alice mints a pairing code', aliceCode.status === 201);
const aliceClaim = await call('POST', '/api/agent/claim', {
	body: { code: aliceCode.body.code, mcVersion: '26.2', modVersion: 'verify-auth', envType: 'integrated' },
});
check('the mod claims it', aliceClaim.status === 200, `agent=${aliceClaim.body.agentId}`);

const bobCode = await call('POST', '/api/agent/pair-codes', { cookie: bobCookie });
const bobClaim = await call('POST', '/api/agent/claim', {
	body: { code: bobCode.body.code, mcVersion: '26.2', modVersion: 'verify-auth', envType: 'dedicated' },
});
check("bob pairs a world of his own", bobClaim.status === 200, `agent=${bobClaim.body.agentId}`);

const aliceAgents = await call('GET', '/api/agent/agents', { cookie: aliceCookie });
const aliceAgentIds = (aliceAgents.body.agents ?? []).map((a) => a.id);
check(
	'alice sees only her world',
	aliceAgentIds.includes(aliceClaim.body.agentId) && !aliceAgentIds.includes(bobClaim.body.agentId),
	`${aliceAgentIds.length} agent(s)`,
);

const anonAgents = await call('GET', '/api/agent/agents');
const anonAgentIds = (anonAgents.body.agents ?? []).map((a) => a.id);
check(
	'a signed-out caller sees neither',
	!anonAgentIds.includes(aliceClaim.body.agentId) && !anonAgentIds.includes(bobClaim.body.agentId),
	`${anonAgentIds.length} unowned agent(s)`,
);

const stealRevoke = await call('DELETE', `/api/agent/agents/${bobClaim.body.agentId}`, { cookie: aliceCookie });
check("revoking bob's world 404s rather than 403s", stealRevoke.status === 404, `${stealRevoke.status} ${stealRevoke.body.error}`);

const bobAgentsAfter = await call('GET', '/api/agent/agents', { cookie: bobCookie });
check(
	"bob's world was not revoked",
	(bobAgentsAfter.body.agents ?? []).some((a) => a.id === bobClaim.body.agentId),
);

// --- ownership: jobs ------------------------------------------------------
console.log('\nownership — jobs');

const crossJob = await call('POST', '/api/agent/jobs', {
	cookie: aliceCookie,
	body: { agentId: bobClaim.body.agentId, buildId: aliceBuild.body.id },
});
check("alice cannot build her build in bob's world", crossJob.status === 404, crossJob.body.error);

const otherCrossJob = await call('POST', '/api/agent/jobs', {
	cookie: aliceCookie,
	body: { agentId: aliceClaim.body.agentId, buildId: bobBuild.body.id },
});
check("alice cannot build bob's build in her own world", otherCrossJob.status === 404, otherCrossJob.body.error);

const ownJob = await call('POST', '/api/agent/jobs', {
	cookie: aliceCookie,
	body: { agentId: aliceClaim.body.agentId, buildId: aliceBuild.body.id },
});
check('her own build in her own world is queued', ownJob.status === 202, `job=${ownJob.body.id}`);

const peek = await call('GET', `/api/agent/jobs/${ownJob.body.id}`, { cookie: bobCookie });
check("bob cannot read alice's job", peek.status === 404);

// The mod has no cookie. This is the check that would have caught a session guard added to
// the wrong route and silently killing the whole in-game feature.
const schem = await fetch(`${ORIGIN}/api/agent/jobs/${ownJob.body.id}/schem`, {
	headers: { Authorization: `Bearer ${aliceClaim.body.agentToken}` },
});
const schemBytes = new Uint8Array(await schem.arrayBuffer());
check('the mod fetches the schematic with only its token', schem.status === 200, `${schemBytes.length} bytes`);
check('it is gzipped NBT', schemBytes[0] === 0x1f && schemBytes[1] === 0x8b);

const wrongAgent = await fetch(`${ORIGIN}/api/agent/jobs/${ownJob.body.id}/schem`, {
	headers: { Authorization: `Bearer ${bobClaim.body.agentToken}` },
});
check("another world's token is refused", wrongAgent.status === 403);

// --- logout ---------------------------------------------------------------
console.log('\nlogout');

const loggedOut = await call('POST', '/api/auth/logout', { cookie: aliceCookie });
check('logout succeeds', loggedOut.status === 200);
const cleared = loggedOut.setCookie.find((c) => c.startsWith('ic_session='));
check('the cookie is cleared', /ic_session=;/.test(cleared ?? '') || /Expires=Thu, 01 Jan 1970/i.test(cleared ?? ''), cleared);

const afterLogout = await call('GET', '/api/me', { cookie: aliceCookie });
check('the old cookie no longer authenticates', afterLogout.status === 401, afterLogout.body.error);

const otherSession = await call('GET', '/api/me', { cookie: aliceSecondCookie });
check('her other session is untouched', otherSession.status === 200, 'logging out of one browser does not sign out the others');

// --- expiry ---------------------------------------------------------------
console.log('\nexpiry');

const expiredToken = randomBytes(32).toString('base64url');
const digest = createHash('sha256').update(expiredToken).digest('hex');
const aliceId = registered.body.user.id;

try {
	psql(
		`INSERT INTO sessions (user_id, token_hash, expires_at) ` +
			`VALUES ('${aliceId}', decode('${digest}', 'hex'), now() - interval '1 hour')`,
	);
	const expired = await call('GET', '/api/me', { cookie: `ic_session=${expiredToken}` });
	check('an expired session does not authenticate', expired.status === 401, expired.body.error);

	// Proving it was really there rules out the check passing because the insert silently
	// failed and the token simply never existed.
	const rows = psql(`SELECT count(*) FROM sessions WHERE token_hash = decode('${digest}', 'hex')`);
	check('the expired row really was in the table', rows === '1', `${rows} row(s)`);

	psql(`DELETE FROM sessions WHERE token_hash = decode('${digest}', 'hex')`);
} catch (err) {
	check('an expired session does not authenticate', false, `could not reach psql: ${err.message}`);
}

// --- cleanup --------------------------------------------------------------
// Only the builds: the accounts are stamped unique per run and are worth leaving behind as
// evidence if something fails.
await call('DELETE', `/api/builds/${aliceBuild.body.id}`, { cookie: aliceSecondCookie });
await call('DELETE', `/api/builds/${bobBuild.body.id}`, { cookie: bobCookie });

console.log(failures === 0 ? '\nall auth checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
