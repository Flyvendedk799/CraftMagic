/**
 * The picture on a generation request.
 *
 * Its own module because it is the one input on the paid path that arrives as megabytes of
 * opaque text: everything that can be checked about it has to be checked before it reaches a
 * provider, where a bad value comes back as a 400 that names nothing the user did.
 */

import type { ProviderImage } from './providers.js';

/** Picture formats every provider here can read. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/**
 * The biggest picture accepted, as base64 characters.
 *
 * The browser crops and downscales to a 768px edge before sending, which lands around 300KB —
 * so this is roughly ten times what a well-behaved client produces, and comfortably under both
 * the body limit and the 5MB every provider caps images at.
 */
export const MAX_IMAGE_BASE64 = 4 * 1024 * 1024;

/**
 * Read the picture off a request body.
 *
 * Three outcomes rather than two, and the distinction is the point: absent means an ordinary
 * written generation, and `'invalid'` has to be refused rather than treated as absent. A
 * picture is the *subject* of the request, so dropping a malformed one would build something
 * unrelated to what the user outlined and charge them a generation for it.
 */
export function readImage(body: unknown): ProviderImage | 'invalid' | null {
	const value = (body as { image?: unknown } | null)?.image;
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object') return 'invalid';

	const { data, mediaType } = value as { data?: unknown; mediaType?: unknown };
	if (typeof data !== 'string' || data.length === 0 || data.length > MAX_IMAGE_BASE64) {
		return 'invalid';
	}
	if (typeof mediaType !== 'string' || !IMAGE_TYPES.includes(mediaType)) return 'invalid';
	// Base64 only. A data-URL prefix or raw bytes reaches the provider as a 400 that says
	// nothing about which field was wrong.
	if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) return 'invalid';

	return { data, mediaType };
}

/**
 * Roughly what a picture costs, in input tokens.
 *
 * Base64 carries three bytes in four characters, and the providers bill an image at about one
 * token per 750 pixels. It errs high, which is the safe direction for a spend ceiling.
 */
export function imageTokens(image: ProviderImage | null): number {
	if (!image) return 0;
	return Math.ceil((image.data.length * 0.75) / 750);
}
