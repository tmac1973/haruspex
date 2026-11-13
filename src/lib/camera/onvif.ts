/**
 * Where a network camera's ONVIF service most likely is, from its RTSP
 * address: the same host on the standard path. For a camera that doesn't
 * answer Find cameras, whose ONVIF service is still there to sign in to.
 */
export function onvifAddressFor(rtspUrl: string): string | null {
	let host: string;
	try {
		const url = new URL(rtspUrl.trim());
		if (url.protocol !== 'rtsp:' && url.protocol !== 'rtsps:') return null;
		host = url.hostname;
	} catch {
		return null;
	}
	return host ? `http://${host}/onvif/device_service` : null;
}

/**
 * `url` with its host `from` replaced by `to`, keeping the scheme, sign-in,
 * port and path; unchanged when its host is something else. For moving a
 * found camera's addresses from the address the router gave it to its name.
 */
export function withHost(url: string, from: string, to: string): string {
	const m = /^([a-z][a-z0-9+.-]*:\/\/)([^@/]*@)?([^:/?#]+)(.*)$/i.exec(url);
	if (!m || m[3].toLowerCase() !== from.toLowerCase()) return url;
	return `${m[1]}${m[2] ?? ''}${to}${m[4]}`;
}

/** The host of `url`, or '' when it has none. */
export function hostOf(url: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/?#]+)/i.exec(url)?.[1] ?? '';
}
