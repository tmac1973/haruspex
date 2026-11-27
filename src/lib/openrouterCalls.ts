/**
 * Calls to OpenRouter's generation APIs (images, videos), shared by the image
 * and video backends: a `fetch` with a timeout and a cancel, and OpenRouter's
 * refusals turned into each layer's own error, so routing knows which to
 * pass over.
 *
 * Plain `fetch` from the webview, as the rest of `#lib/openrouter` makes its
 * calls: OpenRouter is CORS-open.
 */

import { errMessage } from '#lib/utils/error.ts';
import { errorBody, readErrorText } from '#lib/utils/http.ts';
import { OPENROUTER_ATTRIBUTION_HEADERS, OPENROUTER_BASE_URL } from '#lib/openrouter.ts';

/** The kinds both layers' errors share. */
export type CallErrorKind = 'unconfigured' | 'unreachable' | 'rejected' | 'timeout' | 'cancelled';

/** Makes the calling layer's error (`ImageBackendError`, `VideoBackendError`). */
export type MakeError = (
	kind: CallErrorKind,
	message: string,
	opts?: { status?: number; body?: string }
) => Error;

/** `path` under OpenRouter's API. */
export const openRouterUrl = (path: string) => `${OPENROUTER_BASE_URL}${path}`;

/** The headers every call sends, with the key when there is one. */
export function openRouterHeaders(apiKey?: string, json = false): Record<string, string> {
	return {
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		...(json ? { 'Content-Type': 'application/json' } : {}),
		...OPENROUTER_ATTRIBUTION_HEADERS
	};
}

/**
 * `fetch` that gives up after `ms`, or when `signal` aborts, with the body
 * read in that time too. Made by hand: `AbortSignal.any` is missing from the
 * older webviews the app runs in.
 */
export async function fetchWithin(
	ms: number,
	input: string,
	init: RequestInit,
	make: MakeError,
	signal?: AbortSignal
): Promise<Response> {
	if (signal?.aborted) throw make('cancelled', 'Generation cancelled.');
	const ctrl = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		ctrl.abort();
	}, ms);
	const cancel = () => ctrl.abort();
	signal?.addEventListener('abort', cancel, { once: true });
	try {
		const res = await fetch(input, { ...init, signal: ctrl.signal });
		const body = await res.arrayBuffer();
		return new Response(body, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers
		});
	} catch (e) {
		if (signal?.aborted) throw make('cancelled', 'Generation cancelled.');
		if (timedOut) throw make('timeout', 'OpenRouter did not answer in time.');
		throw make('unreachable', `Could not reach OpenRouter: ${errMessage(e)}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', cancel);
	}
}

/**
 * A refusal as the caller's error: a bad key or no credit isn't worth a
 * retry; a 5xx or 429 is, on another model. `what` is what was refused.
 */
export async function refusal(res: Response, make: MakeError, what: string): Promise<Error> {
	const body = await readErrorText(res);
	const said = errorBody(body).message ?? `status ${res.status}`;
	const opts = { status: res.status, body: body.slice(0, 200) };
	if (res.status === 401) {
		return make(
			'unconfigured',
			`OpenRouter refused the key: ${said} — Settings → Inference → API Keys.`,
			opts
		);
	}
	if (res.status === 402) {
		return make('rejected', `OpenRouter: ${said} (the key is out of credit).`, opts);
	}
	// No endpoint left for the model: none serves the request, or the account's
	// privacy settings ruled them all out. Another model may still do it.
	if (res.status === 404) {
		return make(
			'unconfigured',
			`OpenRouter can't make the ${what} with this model: ${said}. The privacy settings ` +
				'on openrouter.ai (data policy, zero data retention, allowed providers) can rule ' +
				'out all of its providers.',
			opts
		);
	}
	const kind = res.status === 429 || res.status >= 500 ? 'unreachable' : 'rejected';
	return make(kind, `OpenRouter refused the ${what}: ${said}`, opts);
}

/** An answer's JSON, or a refusal saying what OpenRouter said. */
export async function jsonOf(res: Response, make: MakeError, what: string): Promise<unknown> {
	if (!res.ok) throw await refusal(res, make, what);
	try {
		return await res.json();
	} catch {
		throw make('rejected', 'OpenRouter sent an answer that is not JSON.');
	}
}
