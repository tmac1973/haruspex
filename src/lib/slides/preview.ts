import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '#lib/debugLog.ts';
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { errMessage } from '#lib/utils/error.ts';
import { normalizeOrientation, normalizeTheme } from '#lib/slides/prepare.ts';
import type { SlideTheme } from '#lib/slides/themes.ts';
import type { SlideOrientation } from '#lib/slides/types.ts';

/**
 * The preview `fs_write_slides` shows a model that can see images: the deck
 * it just wrote, rendered by LibreOffice (`slides_preview_pdf`) and drawn as
 * contact sheets. The model looks for what the fit estimate can't catch
 * (text over a picture, a wrap that leaves one word on a line, a colour that
 * doesn't read) and may write the deck again to fix it.
 *
 * Writing a file twice in a turn is refused (fs-write.ts): a model writing a
 * file in pieces would lose all but the last. A deck the model has seen, or
 * one the turn created, may be written again, a couple of times, if the new
 * one keeps most of its slides: a fix keeps their titles, and a second piece
 * of a deck doesn't. A deck that was there before the turn and wasn't shown
 * to the model is still refused.
 * A rewrite keeps the deck's theme and orientation unless it names others:
 * a model fixing a slide left `theme` out and turned a dark deck light.
 */

/** Rewrites a deck may have in one turn. */
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

/** How a deck looks: what a rewrite keeps unless it names another. */
export interface DeckLook {
	theme: SlideTheme;
	orientation: SlideOrientation;
}

interface Deck {
	titles: string[];
	rewrites: number;
	look: DeckLook;
	/** The file did not exist before the turn wrote it. */
	created: boolean;
	/** The model was shown it. */
	previewed: boolean;
}

/** Decks written this turn, by path, keyed on the turn's own write set. */
const decks = new WeakMap<Set<string>, Map<string, Deck>>();

function turnMap(turn: Set<string>): Map<string, Deck> {
	let map = decks.get(turn);
	if (!map) {
		map = new Map();
		decks.set(turn, map);
	}
	return map;
}

const norm = (title: string) => title.trim().toLowerCase();

/** Note that the deck at `path`, with these slide titles and this look, was
 *  shown to the model. */
export function notePreview(
	turn: Set<string>,
	path: string,
	titles: string[],
	look: DeckLook
): void {
	const map = turnMap(turn);
	const seen = map.get(path);
	map.set(path, {
		titles: titles.map(norm),
		rewrites: seen?.rewrites ?? 0,
		look,
		created: seen?.created ?? false,
		previewed: true
	});
}

/**
 * Note that the deck at `path` was written with these titles and this look.
 * `overwrite` is whether the write replaced a file; on a rewrite the turn's
 * own earlier write is what it replaced.
 */
export function noteDeck(
	turn: Set<string>,
	path: string,
	titles: string[],
	look: DeckLook,
	overwrite: boolean
): void {
	const map = turnMap(turn);
	const seen = map.get(path);
	map.set(path, {
		titles: titles.map(norm),
		rewrites: seen?.rewrites ?? 0,
		look,
		created: seen ? seen.created : !overwrite,
		previewed: seen?.previewed ?? false
	});
}

const named = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

/**
 * The look a write asks for. A rewrite of a deck (`previous`)
 * keeps its theme and orientation where the arguments leave them out.
 */
export function deckLook(args: Record<string, unknown>, previous?: DeckLook): DeckLook {
	return {
		theme: previous && !named(args.theme) ? previous.theme : normalizeTheme(args.theme),
		orientation:
			previous && !named(args.orientation)
				? previous.orientation
				: normalizeOrientation(args.orientation)
	};
}

/** The look of the deck written at `path` this turn, if there was one. */
export function writtenLook(turn: Set<string>, path: string): DeckLook | undefined {
	return decks.get(turn)?.get(path)?.look;
}

/** The deck at `path`, when it was shown to the model or the turn created it,
 *  and it has rewrites left. */
function revisable(turn: Set<string>, path: string): Deck | undefined {
	const seen = decks.get(turn)?.get(path);
	if (!seen || !(seen.previewed || seen.created)) return undefined;
	return seen.rewrites < MAX_REWRITES ? seen : undefined;
}

/** Whether the deck at `path` may be written again with these titles: it was
 *  previewed or created this turn, has rewrites left, and keeps at least half
 *  its slides. */
export function mayRewrite(turn: Set<string>, path: string, titles: string[]): boolean {
	const seen = revisable(turn, path);
	if (!seen) return false;
	const now = new Set(titles.map(norm));
	const kept = seen.titles.filter((t) => now.has(t)).length;
	return kept * 2 >= seen.titles.length;
}

/** Count a rewrite of the deck at `path`. */
export function noteRewrite(turn: Set<string>, path: string): void {
	const seen = decks.get(turn)?.get(path);
	if (seen) seen.rewrites += 1;
}

/** What a refused repeat write of the deck at `path` adds, while it may be rewritten. */
export function deckRewriteHint(turn: Set<string>, path: string): string {
	if (!revisable(turn, path)) return '';
	return 'To revise a deck you created this turn, write the whole deck again, keeping most of its slide titles. ';
}

/** Rewrites the deck at `path` has left this turn. */
export function rewritesLeft(turn: Set<string>, path: string): number {
	return MAX_REWRITES - (decks.get(turn)?.get(path)?.rewrites ?? 0);
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
	titles: string[],
	look: DeckLook
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
	notePreview(ctx.filesWrittenThisTurn, path, titles, look);
	out.result += previewText(preview, path, rewritesLeft(ctx.filesWrittenThisTurn, path) > 0);
	return out;
}
