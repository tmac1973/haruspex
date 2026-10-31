import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '#lib/debugLog.ts';
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { errMessage } from '#lib/utils/error.ts';

/**
 * The preview `fs_write_slides` shows a model that can see images: the deck
 * it just wrote, rendered by LibreOffice (`slides_preview_pdf`) and drawn as
 * contact sheets. The model looks for what the fit estimate can't catch
 * (text over a picture, a wrap that leaves one word on a line, a colour that
 * doesn't read) and may write the deck again to fix it.
 *
 * Writing a file twice in a turn is refused (fs-write.ts): a model writing a
 * file in pieces would lose all but the last. A deck the model has seen may
 * be written again, a couple of times, if the new one keeps most of its
 * slides: a fix keeps their titles, and a second piece of a deck doesn't.
 */

/** Rewrites a previewed deck may have in one turn. */
export const MAX_REWRITES = 2;

/** Rust's message when LibreOffice isn't installed (`fs_tools/preview.rs`). */
const NO_LIBREOFFICE = 'LibreOffice is not installed.';

export interface DeckPreview {
	/** Contact sheets, as JPEG data URLs. */
	sheets: string[];
	shown: number;
	total: number;
}

/** Render the deck at `relPath` for the model; null when there is no
 *  LibreOffice or the render fails, since the deck was written either way. */
export async function previewDeck(workdir: string, relPath: string): Promise<DeckPreview | null> {
	try {
		const pdf = await invoke<ArrayBuffer>('slides_preview_pdf', { workdir, relPath });
		const { renderPdfSheets } = await import('#lib/agent/pdfRender.ts');
		return await renderPdfSheets(new Uint8Array(pdf));
	} catch (e) {
		const reason = errMessage(e);
		if (reason !== NO_LIBREOFFICE) console.warn(`Slide preview failed: ${reason}`);
		else logDebug('slides', 'No LibreOffice, so no slide preview');
		return null;
	}
}

/** What the tool result says alongside the sheets. */
export function previewText(preview: DeckPreview, relPath: string, canRewrite: boolean): string {
	const which =
		preview.shown < preview.total
			? `slides 1–${preview.shown} of ${preview.total}`
			: `all ${preview.total} slides`;
	const fix = canRewrite
		? `If one needs fixing, write the whole deck again to "${relPath}", keeping the slides that are fine.`
		: `It has been rewritten as many times as it can be this turn, so tell the user what still needs fixing.`;
	return (
		`\nThe sheets show ${which} as LibreOffice draws them, numbered. Check each for text ` +
		`that runs off the slide or over a picture, a chart or table too small to read, and ` +
		`colours that don't read. ${fix} If they look right, say so briefly.`
	);
}

interface Previewed {
	titles: string[];
	rewrites: number;
}

/** Decks previewed this turn, by path, keyed on the turn's own write set. */
const previewed = new WeakMap<Set<string>, Map<string, Previewed>>();

function turnMap(turn: Set<string>): Map<string, Previewed> {
	let map = previewed.get(turn);
	if (!map) {
		map = new Map();
		previewed.set(turn, map);
	}
	return map;
}

const norm = (title: string) => title.trim().toLowerCase();

/** Note that the deck at `path`, with these slide titles, was shown to the model. */
export function notePreview(turn: Set<string>, path: string, titles: string[]): void {
	const map = turnMap(turn);
	const rewrites = map.get(path)?.rewrites ?? 0;
	map.set(path, { titles: titles.map(norm), rewrites });
}

/** Whether a deck previewed at `path` may be written again with these titles:
 *  rewrites left, and at least half its slides still there. */
export function mayRewrite(turn: Set<string>, path: string, titles: string[]): boolean {
	const seen = previewed.get(turn)?.get(path);
	if (!seen || seen.rewrites >= MAX_REWRITES) return false;
	const now = new Set(titles.map(norm));
	const kept = seen.titles.filter((t) => now.has(t)).length;
	return kept * 2 >= seen.titles.length;
}

/** Count a rewrite of the deck at `path`. */
export function noteRewrite(turn: Set<string>, path: string): void {
	const seen = previewed.get(turn)?.get(path);
	if (seen) seen.rewrites += 1;
}

/** Rewrites the deck at `path` has left this turn. */
export function rewritesLeft(turn: Set<string>, path: string): number {
	return MAX_REWRITES - (previewed.get(turn)?.get(path)?.rewrites ?? 0);
}

/**
 * After a deck is written: when the model can see images and has none
 * waiting, render the deck and hand it the sheets, saying so in the result.
 * Otherwise, or without LibreOffice, the result is left as it was.
 */
export async function attachPreview(
	out: ToolExecOutput,
	ctx: ToolContext,
	workdir: string,
	path: string,
	titles: string[]
): Promise<ToolExecOutput> {
	if (!out.result.startsWith('Wrote:')) return out;
	// One batch of images at a time: more crashes the inference server
	// (see fs_read_pdf_pages).
	if (ctx.visionSupported === false || ctx.pendingImages.length > 0) return out;
	const preview = await previewDeck(workdir, path);
	if (!preview) return out;
	preview.sheets.forEach((dataUrl, i) => {
		ctx.pendingImages.push({ path: `${path}#sheet${i + 1}`, dataUrl });
	});
	notePreview(ctx.filesWrittenThisTurn, path, titles);
	out.result += previewText(preview, path, rewritesLeft(ctx.filesWrittenThisTurn, path) > 0);
	return out;
}
