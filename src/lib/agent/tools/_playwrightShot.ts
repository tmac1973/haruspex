/**
 * Playwright's `browser_take_screenshot` with a `filename`.
 *
 * Given a name, Playwright writes the file into its own working directory —
 * the server's folder in the app's data, never the user's project — and
 * leaves the picture out of the result. A model that names its shots (most
 * do) then can't see them, and can reach the file only by copying it out of
 * the app's data folder, a command that always asks the user. So the name is
 * taken off the call, the picture comes back for the model to see, and it is
 * saved at that name in the turn's folder: a Code session's project, or
 * Chat's working folder.
 *
 * Matched by the tool's name and its `filename` parameter rather than by the
 * catalog entry, so a Playwright server added by hand behaves the same.
 */
import type { McpToolDescriptor } from '#lib/ipc/gen/McpToolDescriptor.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import { isSaveTarget, prepareSave, writeSaved } from '#lib/agent/tools/_saveGenerated.ts';

const SCREENSHOT_TOOL = 'browser_take_screenshot';

/** The call to send and the name the model asked for; null for any other call. */
export function takeScreenshotName(
	descriptor: Pick<McpToolDescriptor, 'name' | 'inputSchema'>,
	args: Record<string, unknown>
): { args: Record<string, unknown>; filename: string } | null {
	if (descriptor.name !== SCREENSHOT_TOOL) return null;
	const schema = descriptor.inputSchema as { properties?: Record<string, unknown> } | null;
	if (!schema?.properties || !('filename' in schema.properties)) return null;
	const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
	if (!filename) return null;
	const rest = { ...args };
	delete rest.filename;
	return { args: rest, filename };
}

/** The first picture a result carries, as bytes. */
export function firstImageBytes(content: unknown): Uint8Array | null {
	const blocks = Array.isArray(content) ? content : [];
	for (const block of blocks) {
		const b = block as { type?: unknown; data?: unknown };
		if (b.type === 'image' && typeof b.data === 'string' && b.data) {
			return Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0));
		}
	}
	return null;
}

/** Save the shot at the name the model gave; the line to add to the result. */
export async function saveScreenshot(
	filename: string,
	content: unknown,
	ctx: ToolContext
): Promise<string> {
	const bytes = firstImageBytes(content);
	if (!bytes) return `Not saved as ${filename}: the result had no picture.`;
	// A shot retaken after a fix keeps its name, as Playwright's own would.
	const target = await prepareSave(filename, true, ctx, SCREENSHOT_TOOL);
	if (!isSaveTarget(target)) return `Not saved as ${filename}: ${refusalText(target.result)}`;
	const failed = await writeSaved(target, bytes, ctx);
	return failed ?? `Saved as ${target.path} in the working folder.`;
}

/** The message inside a `toolError` envelope, or the text as it is. */
function refusalText(result: string): string {
	try {
		const parsed = JSON.parse(result) as { error?: unknown };
		if (typeof parsed.error === 'string') return parsed.error;
	} catch {
		// Not an envelope.
	}
	return result;
}
