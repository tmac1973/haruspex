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
