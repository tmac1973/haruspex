/**
 * `fetch` for the owner API, which serves HTTPS with a certificate it made
 * itself (src-tauri/src/owner/tls.rs). Node's own fetch can't be told to
 * trust one certificate, so this speaks node:https with `ca` set to it:
 * verification stays on, and only that certificate passes.
 */
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

/**
 * A fetch that trusts `ca` (PEM). Enough of the Response for the driver:
 * `ok`, `status`, `headers.get`, `json()`, `text()`, and `body` to iterate.
 */
export function pinnedFetch(ca) {
	return (url, { method = 'GET', headers = {}, body, signal } = {}) =>
		new Promise((resolve, reject) => {
			// The certificate is checked against the URL's host, as a browser
			// does, even when a test sends another Host header.
			const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
			const check = (_name, cert) => checkServerIdentity(host, cert);
			// No keep-alive agent: an idle socket would keep a script from exiting.
			const options = { method, headers, ca, signal, checkServerIdentity: check, agent: false };
			const req = request(url, options, (res) => {
				// As fetch does: a stream cut by `signal` ends in an AbortError,
				// not node's "aborted".
				const body = (async function* () {
					try {
						yield* res;
					} catch (e) {
						throw signal?.aborted ? signal.reason : e;
					}
				})();
				const text = async () => {
					let out = '';
					for await (const chunk of body) out += chunk;
					return out;
				};
				resolve({
					ok: res.statusCode >= 200 && res.statusCode < 300,
					status: res.statusCode,
					headers: {
						get: (name) => {
							const v = res.headers[name.toLowerCase()];
							return Array.isArray(v) ? v.join(', ') : (v ?? null);
						}
					},
					body,
					text,
					json: async () => JSON.parse(await text())
				});
			});
			req.on('error', reject);
			req.end(body);
		});
}
