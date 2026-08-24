/**
 * A throwaway account for the verification drivers.
 *
 * Pairing, jobs, builds and generation all require a session now, because an anonymous scope
 * on a public deployment is one shared pool — every signed-out visitor would see the same
 * paired Minecraft worlds. That is right for the product and it means the drivers can no
 * longer act as "nobody", so each one signs in first.
 *
 * The account is stamped with the current time rather than reused, so two drivers running at
 * once cannot fight over the same worlds and builds, and a failed run leaves its own evidence
 * behind instead of overwriting the last one's.
 */

const PASSWORD = 'verification-driver-password';

/** A fresh account. Unique per call, so runs never share state. */
export function throwawayCredentials(label) {
	return { email: `${label}-${Date.now()}-${process.pid}@example.test`, password: PASSWORD };
}

/**
 * Register (or log in, if the address is taken) and return the `Cookie` header value.
 *
 * `getSetCookie` rather than `get('set-cookie')`: the latter joins multiple cookies into one
 * comma-separated string, which is unparseable the moment any value contains a comma.
 */
export async function signIn(origin, credentials) {
	for (const path of ['/api/auth/register', '/api/auth/login']) {
		const response = await fetch(`${origin}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(credentials),
		});

		if (response.ok) {
			const cookie = (response.headers.getSetCookie() ?? [])
				.find((c) => c.startsWith('ic_session='))
				?.split(';')[0];
			if (!cookie) throw new Error(`${path} succeeded but issued no session cookie`);
			const body = await response.json();
			return { cookie, userId: body.user?.id, email: credentials.email };
		}

		// 409 means the address is already registered, which is the one failure worth
		// retrying as a login. Anything else is a real problem and should say so.
		if (response.status !== 409) {
			const body = await response.text();
			throw new Error(`${path} failed: HTTP ${response.status} ${body}`);
		}
	}

	throw new Error('could not obtain a session');
}

/**
 * Put a session cookie into a running browser over CDP.
 *
 * Faster and far less brittle than typing into the sign-in form for a driver whose subject is
 * something else entirely — `verify-library.mjs` already proves the form itself works, so
 * repeating it here would only add a way for an unrelated test to fail.
 */
export async function seedBrowserSession(send, origin, cookie) {
	const [name, value] = cookie.split('=');
	const url = new URL(origin);
	await send('Network.enable');
	await send('Network.setCookie', {
		name,
		value,
		domain: url.hostname,
		path: '/',
		httpOnly: true,
		sameSite: 'Lax',
	});
}
