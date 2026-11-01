/**
 * The Remote control API (`POST /api/v1/op`), as the model eval uses it.
 *
 * The app's certificate is its own, so this trusts it for a loopback address
 * only. Another computer needs `--cookie` (a paired device's `haruspex_owner`
 * cookie) and `--ca` (the app's certificate, which `npm run drive -- status`
 * names as `apiCa`).
 */
import { request } from 'node:https';
import { readFileSync } from 'node:fs';

export function apiClient({ base = 'https://localhost:8788', cookie, ca } = {}) {
	const url = new URL('/api/v1/op', base);
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	const tls = ca ? { ca: readFileSync(ca) } : { rejectUnauthorized: !loopback };

	/** Send one engine operation and return its `value`; throws on an error answer. */
	return function op(body) {
		const payload = JSON.stringify(body);
		return new Promise((resolve, reject) => {
			const req = request(
				url,
				{
					method: 'POST',
					...tls,
					headers: {
						'Content-Type': 'application/json',
						'X-Haruspex': '1',
						Origin: url.origin,
						...(cookie ? { Cookie: `haruspex_owner=${cookie}` } : {})
					}
				},
				(res) => {
					let text = '';
					res.setEncoding('utf8');
					res.on('data', (c) => (text += c));
					res.on('end', () => {
						let json;
						try {
							json = JSON.parse(text);
						} catch {
							return reject(
								new Error(`${body.type}: HTTP ${res.statusCode} ${text.slice(0, 200)}`)
							);
						}
						if (res.statusCode !== 200 || json.error) {
							return reject(new Error(`${body.type}: ${json.error ?? `HTTP ${res.statusCode}`}`));
						}
						resolve(json.value);
					});
				}
			);
			req.on('error', reject);
			req.end(payload);
		});
	};
}
