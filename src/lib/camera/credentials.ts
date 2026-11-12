/**
 * A camera address with its sign-in written into it (`rtsp://user:pass@host/…`),
 * as cameras' own manuals print it. Settings → Cameras keeps the user name and
 * password in their own fields, and the password in the secret store, so the
 * stored address never holds either.
 */

export interface SplitUrl {
	/** The address without `user:pass@`. */
	url: string;
	/** Null when the address carried no sign-in. */
	username: string | null;
	password: string | null;
}

function decode(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

/**
 * Take `user:pass@` out of `url`. The last `@` ends the sign-in, so a
 * password that holds an unescaped `@` still comes out whole.
 */
export function splitUrlCredentials(raw: string): SplitUrl {
	const url = raw.trim();
	const m = /^([a-z][a-z0-9+.-]*:\/\/)(.+)@([^@]*)$/i.exec(url);
	if (!m || m[2].includes('/')) return { url, username: null, password: null };
	const userinfo = m[2];
	const colon = userinfo.indexOf(':');
	return {
		url: m[1] + m[3],
		username: decode(colon < 0 ? userinfo : userinfo.slice(0, colon)),
		password: colon < 0 ? null : decode(userinfo.slice(colon + 1))
	};
}

/**
 * An error to show the user, with the password and any `user:pass@` taken
 * out. Rust redacts its own errors; this covers a password the form only
 * holds in memory.
 */
export function redactCameraError(text: string, password: string): string {
	let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
	if (password) out = out.split(password).join('***');
	return out;
}
