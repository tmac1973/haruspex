/**
 * What `chat.send` and `session.send` carry besides text, for clients other
 * than this window's own input boxes: pictures, and the `/name` a message
 * starts with. Each is handled as the input boxes handle it, so a message
 * from elsewhere reaches the model as one typed here would.
 */
import { invoke } from '@tauri-apps/api/core';
import { imageHashFromUrl } from '#lib/images/url.ts';
import { runSlash, type SlashHost } from '#lib/slash/slash.ts';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { downscaleDataUrl } from '#lib/utils/image.ts';

/** Most pictures one message may carry. */
export const MAX_IMAGES = 8;

const HASH = /^[0-9a-f]{64}$/;
const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,/;

/** The type a picture's first bytes say it is. */
function mimeOf(b: Uint8Array): string {
	if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
	if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
	if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
	return 'image/png';
}

/**
 * A message's pictures as the input boxes attach them: data URLs, downscaled.
 * Each is a hash `/api/v1/upload` answered, one of the app's image URLs, or a
 * data URL. Throws on anything else, and on a hash the cache hasn't got.
 */
export async function attachImages(refs: unknown): Promise<string[]> {
	if (refs === undefined || refs === null) return [];
	if (!Array.isArray(refs)) throw new Error('images is a list of picture hashes');
	if (refs.length > MAX_IMAGES) throw new Error(`a message carries at most ${MAX_IMAGES} pictures`);
	const out: string[] = [];
	for (const ref of refs) {
		if (typeof ref !== 'string') throw new Error('images is a list of picture hashes');
		if (DATA_URL.test(ref)) {
			out.push(await downscaleDataUrl(ref));
			continue;
		}
		const hash = HASH.test(ref) ? ref : imageHashFromUrl(ref);
		if (!hash) {
			throw new Error(`${ref.slice(0, 40)} isn't a picture: upload it first (/api/v1/upload)`);
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await invoke<ArrayBuffer>('image_read_bytes', { hash }));
		} catch {
			throw new Error(`no picture ${hash.slice(0, 12)}… here: upload it again`);
		}
		out.push(await downscaleDataUrl(`data:${mimeOf(bytes)};base64,${bytesToBase64(bytes)}`));
	}
	return out;
}

/** What a client's `/name` came to: a message to send, or a command that ran. */
export type SlashResult =
	| { kind: 'send'; skill?: SkillDoc }
	/** A built-in ran. `note` is what the input box would show; `id` a chat or session it made. */
	| { kind: 'handled'; note?: string; id?: string };

/**
 * Run the `/name` at the start of `text` as the input boxes do, with the
 * host `make` builds for the tab. Its notes come back to the client rather
 * than showing here (`make` is handed the note-taker, for a host that notes
 * something itself), and `newConversation` may answer the id it made.
 */
export async function slashFor(
	text: string,
	make: (addNote: (text: string) => void) => Omit<SlashHost, 'addNote' | 'newConversation'> & {
		newConversation: () => Promise<string | void>;
	}
): Promise<SlashResult> {
	let note: string | undefined;
	let made: Promise<string | void> | undefined;
	const addNote = (t: string) => (note = t);
	const host = make(addNote);
	const outcome = await runSlash(text, {
		...host,
		addNote,
		newConversation: () => {
			made = host.newConversation();
		}
	});
	if (outcome.kind === 'send') return outcome;
	const id = (await made) ?? undefined;
	return { kind: 'handled', ...(note !== undefined && { note }), ...(id && { id }) };
}
