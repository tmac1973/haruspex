/**
 * Playwright's `browser_navigate` to a page on this computer runs without
 * asking.
 *
 * The server marks the tool destructive and open-world, which is right for
 * the web: a page can submit a form or start something on a site. But a Code
 * session testing the app or game it is building navigates to `localhost`
 * every few steps, and a prompt that often teaches the user to click it
 * without reading. Any other address, and any other scheme, still asks.
 *
 * Matched by the tool's name and its `url` parameter rather than by the
 * catalog entry, so a Playwright server added by hand behaves the same.
 */
import type { McpToolDescriptor } from '#lib/ipc/gen/McpToolDescriptor.ts';
import { isLoopbackHost } from '#lib/utils/loopback.ts';

const NAVIGATE_TOOL = 'browser_navigate';

/** Whether this call opens an http(s) page on this computer. */
export function isLocalNavigation(
	descriptor: Pick<McpToolDescriptor, 'name' | 'inputSchema'>,
	args: Record<string, unknown>
): boolean {
	if (descriptor.name !== NAVIGATE_TOOL) return false;
	const schema = descriptor.inputSchema as { properties?: Record<string, unknown> } | null;
	if (!schema?.properties || !('url' in schema.properties)) return false;
	if (typeof args.url !== 'string') return false;
	let url: URL;
	try {
		url = new URL(args.url);
	} catch {
		// Playwright adds https:// to a bare host; whatever that reaches, ask.
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	return isLoopbackHost(url.hostname);
}
