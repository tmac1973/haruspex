/**
 * Which models may receive camera frames and sound. The local model always
 * may, OpenRouter never may, and a remote server only when the user marked it
 * as their own in Settings → Cameras — which it can only be when its address
 * is on their own network (private, loopback or link-local, a `.local` /
 * `.internal` name, or a name with no dot).
 */
import type { BackendDescriptor } from '#lib/inference/descriptor.ts';
import { OPENROUTER_BASE_URL } from '#lib/openrouter.ts';
import { getSettings, normalizeServerUrl } from '#lib/stores/settings.ts';

/** An IPv4 address's four parts, or null when `host` isn't one. */
function ipv4(host: string): number[] | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return null;
	const parts = m.slice(1).map(Number);
	return parts.every((p) => p <= 255) ? parts : null;
}

function privateIpv4([a, b]: number[]): boolean {
	return (
		a === 10 ||
		a === 127 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
}

/** `host` is an IPv6 address (without brackets) on this computer or the local network. */
function privateIpv6(host: string): boolean {
	if (host === '::1') return true;
	// An IPv4-mapped address, which the URL parser writes in hex (::ffff:c0a8:101).
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
	if (mapped) {
		const hi = parseInt(mapped[1], 16);
		const lo = parseInt(mapped[2], 16);
		return privateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
	}
	const first = host.split(':')[0];
	if (first.length !== 4) return false;
	// fc00::/7 (unique local) and fe80::/10 (link-local).
	return /^f[cd]/.test(first) || /^fe[89ab]/.test(first);
}

/**
 * Whether a server at `url` can be marked as the user's own: its host is
 * private, loopback or link-local, a `.local` / `.internal` name, or a name
 * with no dot (`compute`), which only the local network's resolver can answer.
 * A public address or name never can, and OpenRouter never can.
 */
export function isTrustableServer(url: string): boolean {
	let host: string;
	try {
		host = new URL(url.trim()).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (!host || host === new URL(OPENROUTER_BASE_URL).hostname) return false;
	if (host.startsWith('[') && host.endsWith(']')) return privateIpv6(host.slice(1, -1));
	const v4 = ipv4(host);
	if (v4) return privateIpv4(v4);
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal') ||
		!host.includes('.')
	);
}

/** A server address as `cameraTrustedServers` stores and compares it. */
export function trustedServerKey(url: string): string {
	return normalizeServerUrl(url);
}

/**
 * Whether camera frames and sound may go to the model `descriptor` names:
 * always for the local model, never for OpenRouter, and for a remote server
 * only when it is in `trusted` (Settings → Cameras) and on the user's own
 * network.
 */
export function cameraDataAllowed(
	descriptor: Pick<BackendDescriptor, 'kind' | 'baseUrl'>,
	trusted: readonly string[] = getSettings().cameraTrustedServers
): boolean {
	if (descriptor.kind === 'local') return true;
	if (descriptor.kind !== 'remote') return false;
	const key = trustedServerKey(descriptor.baseUrl);
	return !!key && isTrustableServer(key) && trusted.some((url) => trustedServerKey(url) === key);
}
