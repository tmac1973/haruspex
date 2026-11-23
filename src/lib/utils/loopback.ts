/**
 * `localhost`, a `.localhost` name, 127.0.0.0/8 or `[::1]`, as `URL` spells
 * them (lower case, IPv6 in brackets). The TypeScript side of
 * `net_util::is_loopback_host`.
 */
export function isLoopbackHost(host: string): boolean {
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '[::1]' ||
		/^127(\.\d{1,3}){3}$/.test(host)
	);
}
