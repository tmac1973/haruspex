import { invoke } from '@tauri-apps/api/core';
import { IPC } from '#lib/ipc/commands.ts';
import {
	ensureUrlScheme,
	fsWorkdir,
	labelArg,
	resolveShellPath,
	toolInvokeError,
	wslDistroArg
} from '#lib/agent/tools/_helpers.ts';
import { registerTool, registerToolAlias } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { IMAGE_EXT_RE } from '#lib/agent/tools/fs-read.ts';
import { lintPythonIfApplicable } from '#lib/agent/tools/python-lint.ts';
import { localWriteBlocked } from '#lib/agent/tools/nested-session.ts';
import type { EditResult } from '#lib/ipc/gen/EditResult.ts';
import { errMessage } from '#lib/utils/error.ts';
import { buildWriteDiff } from '#lib/code/diff.ts';
import { buildPptx } from '#lib/slides/pptx.ts';
import { loadSlideImages } from '#lib/slides/images.ts';
import { foldForOdp } from '#lib/slides/odp.ts';
import { bulletText, normalizeSlide, settleLayout } from '#lib/slides/prepare.ts';
import { SLIDE_SCHEMA } from '#lib/slides/schema.ts';
import {
	attachPreview,
	deckLook,
	deckRewriteHint,
	mayRewrite,
	noteDeck,
	noteRewrite,
	writtenLook
} from '#lib/slides/preview.ts';
import { prepareVisuals, visualTexts } from '#lib/slides/visuals.ts';
import { SLIDE_THEMES } from '#lib/slides/themes.ts';
import type { Slide } from '#lib/slides/types.ts';
import {
	DOCUMENT,
	SPREADSHEET,
	draftRewriteHint,
	firstLine,
	mayRewriteDraft,
	normText,
	noteDraft,
	type DraftKind
} from '#lib/agent/tools/_drafts.ts';

/**
 * True when a relative write path stays inside `root` (a relative dir prefix).
 * Rejects absolute paths and `..` traversal. Backs ToolContext.writeRoot.
 */
export function isUnderWriteRoot(relPath: string, root: string): boolean {
	const slashed = relPath.replace(/\\/g, '/');
	// After the backslash swap, so a leading backslash and a drive letter count.
	if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return false;
	const np = slashed.replace(/^\.\/+/, '').replace(/\/+/g, '/');
	if (np.split('/').includes('..')) return false;
	const nr = root
		.replace(/\\/g, '/')
		.replace(/^\.?\/+/, '')
		.replace(/\/+/g, '/')
		.replace(/\/+$/, '');
	return np === nr || np.startsWith(`${nr}/`);
}

/** Guard a write against ctx.writeRoot; returns an error string if out of bounds. */
function writeRootError(rawPath: unknown, ctx: ToolContext): string | null {
	const root = ctx.writeRoot?.trim();
	if (!root) return null;
	const path = typeof rawPath === 'string' ? rawPath : '';
	if (!isUnderWriteRoot(path, root)) {
		return (
			`This run may only write inside ${root}. Refusing to write ` +
			`"${path || '(empty path)'}" — put the file under ${root}.`
		);
	}
	return null;
}

/**
 * Compact edit confirmation from the Rust `EditResult` — the changed line
 * number plus a `[fuzzy]` note when the match needed the whitespace/quote
 * fuzzy fallback. Deliberately not a full diff (keeps tool output small).
 */
function formatEditResult(path: string, r: EditResult): string {
	return `Edited ${path} (line ${r.first_changed_line})${r.used_fuzzy ? ' [fuzzy match]' : ''}`;
}

/** How a write treats an existing file and a repeat write in one turn. */
interface WriteOptions {
	/** False in a Code session: an existing file is overwritten without asking. */
	askBeforeOverwrite?: boolean;
	/**
	 * Files a second write may replace (`ToolContext.filesRewritableThisTurn`).
	 * A Code session's only; a write takes its path back out of it.
	 */
	rewritable?: Set<string>;
	/** Give the turn's slot back while the overwrite prompt waits (`ToolContext.releaseSlot`). */
	releaseSlot?: () => void;
	/** The chat whose turn writes, named on the overwrite prompt (`ToolContext.conversationId`). */
	chatId?: string;
	/**
	 * False for a file fs_edit_text can't change (a document, spreadsheet,
	 * deck or download), so a refused repeat write doesn't send the model there.
	 */
	editable?: boolean;
	/** Said after a refused repeat write, before the advice to use a new name. */
	repeatHint?: string;
}

/**
 * A tool's write options: a Code session overwrites, and may rewrite after a
 * command; a job run overwrites; a chat asks.
 */
function writeOptions(ctx: ToolContext): WriteOptions {
	if (!ctx.codeSessionId) {
		return {
			askBeforeOverwrite: ctx.jobRunId === undefined,
			releaseSlot: ctx.releaseSlot,
			chatId: ctx.conversationId
		};
	}
	return { askBeforeOverwrite: false, rewritable: ctx.filesRewritableThisTurn };
}

/** `opts`, letting a second write this turn replace `path` too. */
function rewriting(opts: WriteOptions, path: string): WriteOptions {
	return { ...opts, rewritable: new Set([...(opts.rewritable ?? []), path]) };
}

/**
 * Outcome of pre-write conflict resolution.
 *  - `ok`       proceed with the write.
 *  - `canceled` the user declined at the conflict modal.
 *  - `rejected` we refused the write outright; `message` explains why.
 */
type WriteResolution =
	| { kind: 'ok'; finalPath: string; overwrite: boolean }
	| { kind: 'canceled' }
	| { kind: 'rejected'; message: string };

/**
 * Check whether a write to `relPath` would clobber an existing file,
 * and if so, show the file-conflict modal to let the user pick.
 *
 * Exported for tests: the repeat-write guard below is the whole reason a
 * chunked write can't silently lose its prefix, so it is worth asserting
 * directly rather than only through a tool executor.
 */
export async function resolveWritePathInteractive(
	workdir: string,
	relPath: string,
	filesWrittenThisTurn: Set<string>,
	opts: WriteOptions = {}
): Promise<WriteResolution> {
	// Second write to the same path in one turn. This used to short-circuit to
	// overwrite:true and still report "Wrote: <path>", so a model emitting a
	// long document as several sequential writes saw N successes and left only
	// the LAST chunk on disk — the prefix-loss half of the "middle slice"
	// corruption, reachable with no truncation involved at all. There is no
	// append mode, so refusing is the only honest answer.
	//
	// A Code session may rewrite a file once a command has run since it wrote
	// it: the agent tested its work and is now replacing it whole, which is a
	// fix, not a chunk. Back-to-back writes are still refused.
	if (filesWrittenThisTurn.has(relPath)) {
		if (!opts.rewritable?.has(relPath)) {
			const message = repeatWriteMessage(relPath, opts.editable !== false, opts.repeatHint);
			return { kind: 'rejected', message };
		}
		// This turn wrote the file, so replacing it is no one else's to approve.
		return { kind: 'ok', finalPath: relPath, overwrite: true };
	}

	let exists: boolean;
	try {
		exists = await invoke<boolean>('fs_path_exists', { workdir, relPath });
	} catch {
		exists = false;
	}
	if (!exists) {
		return { kind: 'ok', finalPath: relPath, overwrite: false };
	}

	// A Code session edits a project: rewriting a file is the job, and the
	// write shows as a diff card against what was there, so it doesn't ask.
	// A job run can't show a modal either: its writes overwrite (the job
	// authoring UI says so). Decided per turn, never from the global
	// auto-approve scope, which a chat running beside the job would see too.
	if (opts.askBeforeOverwrite === false) {
		return { kind: 'ok', finalPath: relPath, overwrite: true };
	}

	const { askFileConflict } = await import('#lib/stores/fileConflict.svelte.ts');
	opts.releaseSlot?.();
	const choice = await askFileConflict(relPath, opts.chatId ?? null);
	if (choice === 'cancel') {
		return { kind: 'canceled' };
	}
	if (choice === 'overwrite') {
		return { kind: 'ok', finalPath: relPath, overwrite: true };
	}
	try {
		const newPath = await invoke<string>('fs_find_available_path', { workdir, relPath });
		return { kind: 'ok', finalPath: newPath, overwrite: false };
	} catch (e) {
		// The user chose to keep the existing file. Overwriting it because no
		// free name was found would do the one thing they declined.
		return {
			kind: 'rejected',
			message:
				`"${relPath}" already exists and no free name could be found next to it ` +
				`(${errMessage(e)}). The existing file was left alone — ask the user for a ` +
				`different filename.`
		};
	}
}

function repeatWriteMessage(relPath: string, editable: boolean, hint = ''): string {
	const refused =
		`"${relPath}" was already written in this turn, and writing it again would ` +
		`replace what you just wrote rather than add to it. Do not write a file in ` +
		`pieces: emit a single fs_write_* call containing the file's complete content. `;
	if (editable) return refused + 'To change part of a file you already wrote, use fs_edit_text.';
	const dot = relPath.lastIndexOf('.');
	const next = dot > 0 ? `${relPath.slice(0, dot)}-2${relPath.slice(dot)}` : `${relPath}-2`;
	return (
		refused +
		hint +
		`This format can't be edited in place: if what you wrote is wrong, write the ` +
		`corrected file to a new name such as "${next}" and tell the user which one to keep.`
	);
}

export function userCanceledWriteError(relPath: string, command: string): ToolExecOutput {
	return toolResult(
		toolError(
			`User canceled the ${command} write. The file "${relPath}" already exists in the working directory and the user chose to stop instead of overwriting or renaming. Do NOT retry automatically — stop what you were doing, briefly explain to the user that the file already exists, and ask them how they'd like to proceed (pick a different filename, overwrite the existing file, or skip the write entirely).`
		)
	);
}

/**
 * Generic write wrapper — deduplicates the resolve/invoke/track pattern
 * shared by all fs_write_* tools. `tool` names the write in what the model
 * reads; `command` is the Rust command that writes the format.
 */
/** A write that can't be `invoke(command, args)` with JSON args: a slide deck
 *  goes to Rust as the raw body. Called with the path the user settled on. */
type RawWrite = (relPath: string, overwrite: boolean) => Promise<unknown>;

async function fsWriteWithConflictCheck(
	tool: string,
	command: string | RawWrite,
	workdir: string,
	relPath: string,
	payload: Record<string, unknown>,
	filesWrittenThisTurn: Set<string>,
	toolOpts: WriteOptions,
	diffAfter?: string
): Promise<ToolExecOutput> {
	// Only a plain text file can be fixed with fs_edit_text after a repeat write.
	const opts = { ...toolOpts, editable: tool === 'fs_write_text' };
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn, opts);
	if (resolved.kind === 'canceled') return userCanceledWriteError(relPath, tool);
	if (resolved.kind === 'rejected') return toolResult(toolError(resolved.message));
	const before = diffAfter === undefined ? undefined : await previousContent(workdir, resolved);
	try {
		if (typeof command === 'string') {
			await invoke(command, {
				workdir,
				relPath: resolved.finalPath,
				...payload,
				overwrite: resolved.overwrite
			});
		} else {
			await command(resolved.finalPath, resolved.overwrite);
		}
		filesWrittenThisTurn.add(resolved.finalPath);
		opts.rewritable?.delete(resolved.finalPath);
		const diag = await lintPythonIfApplicable(workdir, resolved.finalPath);
		const out = toolResult(`Wrote: ${resolved.finalPath}${diag}`);
		if (diffAfter !== undefined && before !== undefined) {
			out.fileDiff = buildWriteDiff(resolved.finalPath, before, diffAfter);
		}
		return out;
	} catch (e) {
		return toolResult(toolInvokeError(tool, e));
	}
}

/**
 * The Rust command a write runs and the path it writes (trimmed), or why the
 * path can't be written by this tool.
 */
type CommandChoice = { command: string; path: string } | { error: string };

/**
 * The merged writers take several formats, and the path's extension picks
 * one: `fs_write_document` writes report.pdf as a PDF and report.docx as Word.
 * `hint` points a path the tool can't write at the tool that can.
 */
function byExtension(
	tool: string,
	formats: Record<string, string>,
	hint = ''
): (path: unknown) => CommandChoice {
	const list = Object.keys(formats)
		.map((e) => `.${e}`)
		.join(', ');
	return (raw) => {
		const path = typeof raw === 'string' ? raw.trim() : '';
		if (!path) return { error: `${tool} needs a path ending in ${list}.` };
		const lower = path.toLowerCase();
		const ext = Object.keys(formats).find((e) => lower.endsWith(`.${e}`));
		if (ext) return { command: formats[ext], path };
		return { error: `${tool} writes ${list} files: end the path with one of those.${hint}` };
	};
}

const DOCUMENT_FORMATS = {
	docx: IPC.fs_write_docx,
	odt: IPC.fs_write_odt,
	pdf: IPC.fs_write_pdf
};
const SPREADSHEET_FORMATS = { xlsx: IPC.fs_write_xlsx, ods: IPC.fs_write_ods };
const SLIDE_FORMATS = { pptx: IPC.fs_write_pptx, odp: IPC.fs_write_odp };

const documentCommand = byExtension(
	'fs_write_document',
	DOCUMENT_FORMATS,
	' For .md or .txt use fs_write_text.'
);
const spreadsheetCommand = byExtension(
	'fs_write_spreadsheet',
	SPREADSHEET_FORMATS,
	' For .csv use fs_write_text.'
);
const slidesCommand = byExtension('fs_write_slides', SLIDE_FORMATS);

/**
 * The tools the merged writers replaced, by name and the extension each one
 * wrote. A model may still call them (an old conversation, a habit), so each
 * routes to its replacement with the format it always wrote: a path with
 * another extension gets that one added.
 */
export const LEGACY_WRITE_TOOLS: Record<string, { tool: string; ext: string }> = {
	fs_write_docx: { tool: 'fs_write_document', ext: 'docx' },
	fs_write_odt: { tool: 'fs_write_document', ext: 'odt' },
	fs_write_pdf: { tool: 'fs_write_document', ext: 'pdf' },
	fs_write_xlsx: { tool: 'fs_write_spreadsheet', ext: 'xlsx' },
	fs_write_ods: { tool: 'fs_write_spreadsheet', ext: 'ods' },
	fs_write_pptx: { tool: 'fs_write_slides', ext: 'pptx' },
	fs_write_odp: { tool: 'fs_write_slides', ext: 'odp' }
};

function withExtension(ext: string) {
	return (args: Record<string, unknown>): Record<string, unknown> => {
		if (typeof args.path !== 'string') return args;
		if (args.path.toLowerCase().endsWith(`.${ext}`)) return args;
		return { ...args, path: `${args.path}.${ext}` };
	};
}

/**
 * The file a write is about to replace, for its diff card: null when the
 * write creates it, undefined when it exists but can't be read as text (no
 * diff then, rather than a wrong one).
 */
async function previousContent(
	workdir: string,
	resolved: { finalPath: string; overwrite: boolean }
): Promise<string | null | undefined> {
	if (!resolved.overwrite) return null;
	try {
		return await invoke<string>('fs_read_text_full', { workdir, relPath: resolved.finalPath });
	} catch {
		return undefined;
	}
}

// Per-tool executors below specialize on the input shape — text-content,
// spreadsheet, slides — and each runs a shape-specific validator before
// dispatching to fsWriteWithConflictCheck. The validators exist because
// unattended runs (jobs) have no way to notice the tool wrote a stub
// file and reported "Wrote: foo" — without them, scaffold/placeholder
// inputs silently produce useless files.

// Sheet schema for fs_write_spreadsheet (.xlsx and .ods).
const SHEETS_SCHEMA = {
	type: 'array' as const,
	description:
		'One object per sheet. Cells are literal values: numeric strings become numbers, strings starting with "=" become formulas (e.g. "=SUM(B2:B10)"), anything else is text.',
	items: {
		type: 'object' as const,
		properties: {
			name: { type: 'string' as const, description: 'Sheet (tab) name.' },
			rows: {
				type: 'array' as const,
				description: 'Every row to write, header row first. Each row is a list of cells.',
				items: { type: 'array' as const, items: { type: 'string' as const } }
			}
		},
		required: ['name', 'rows']
	}
};

/**
 * Reject obviously stub spreadsheet input — empty sheets, placeholder
 * rows like ["/formula"], scaffolds where a whole column is blank,
 * single rows that crammed multi-row data into one row, etc. Small
 * local models sometimes write a "scaffold" call expecting the tool to
 * fill in real data; without this guard the tool silently writes
 * nonsense and reports success.
 */
function validateSheets(sheets: unknown): string | null {
	if (!Array.isArray(sheets) || sheets.length === 0) {
		return 'sheets must be a non-empty array.';
	}
	for (let i = 0; i < sheets.length; i++) {
		const err = validateSheet(sheets[i], i + 1);
		if (err) return err;
	}
	return null;
}

/**
 * If the model sent a JSON-stringified array instead of a real array,
 * parse it. Anything else passes through untouched.
 */
function parseIfJsonArray(value: unknown): unknown {
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// fall through — let the validator report the shape error
		}
	}
	return value;
}

/**
 * Coerce sheet cells to the strings Rust expects (Vec<Vec<String>>).
 * Models routinely emit numbers/booleans as bare JSON values — those are
 * real data, not blanks. null/undefined become empty cells. `rows` sent as
 * a JSON string is parsed, like `sheets` itself. Objects and arrays are left
 * alone for `validateSheet` to refuse: `String()` would write them as
 * "[object Object]" or "1,2".
 */
function normalizeSheets(raw: unknown): unknown {
	const sheets = parseIfJsonArray(raw);
	if (!Array.isArray(sheets)) return sheets;
	return sheets.map((sheet) => {
		if (!sheet || typeof sheet !== 'object') return sheet;
		const s = sheet as { rows?: unknown };
		const rows = parseIfJsonArray(s.rows);
		if (!Array.isArray(rows)) return sheet;
		return {
			...s,
			rows: rows.map((row) => (Array.isArray(row) ? row.map(normalizeCell) : row))
		};
	});
}

function normalizeCell(cell: unknown): unknown {
	if (cell == null) return '';
	return typeof cell === 'object' ? cell : String(cell);
}

/**
 * Tool-call syntax inside a value: what a model leaves behind when it garbles
 * a call, e.g. a cell holding `"], ["` and `</parameter> </sheets>`. Written
 * as-is, the file looks fine to the model ("Wrote: …") and is junk to the user.
 */
const CALL_MARKUP_RE = /<\/?(?:(?:parameter|tool_call|function)\b|fs_write_)/i;

function callMarkupError(where: string, text: unknown): string | null {
	if (typeof text !== 'string') return null;
	const found = CALL_MARKUP_RE.exec(text);
	if (!found) return null;
	return (
		`${where} contains tool-call markup ("${found[0]}"), so the call was garbled. ` +
		`Nothing was written. Send the call again with plain values.`
	);
}

/** The first cell holding call markup, as an error naming its position. */
function sheetMarkupError(rows: unknown[][], sheetNum: number): string | null {
	for (let r = 0; r < rows.length; r++) {
		for (let c = 0; c < rows[r].length; c++) {
			const err = callMarkupError(`Sheet ${sheetNum} row ${r + 1} cell ${c + 1}`, rows[r][c]);
			if (err) return err;
		}
	}
	return null;
}

/** The first title, subtitle, bullet, note, or chart or table text holding
 *  call markup. */
function slideMarkupError(slide: Record<string, unknown>, num: number): string | null {
	const bullets = [slide.bullets, slide.right].flatMap((b) =>
		Array.isArray(b) ? b.map(bulletText) : []
	);
	const texts = [slide.title, slide.subtitle, slide.notes, ...bullets, ...visualTexts(slide)];
	for (const text of texts) {
		const err = callMarkupError(`Slide ${num}`, text);
		if (err) return err;
	}
	return null;
}

/** A lone `/word` cell or bullet — what a model writes when it expects the
 *  tool to fill in a template. */
function isPlaceholderText(text: string): boolean {
	return /^\/[a-z_]+$/i.test(text.trim());
}

function isBlankCell(cell: unknown): boolean {
	// Numeric and boolean cells are data, not blanks — the model just
	// emitted them as bare JSON values instead of strings.
	if (typeof cell === 'number' || typeof cell === 'boolean') return false;
	return typeof cell !== 'string' || cell.trim().length === 0;
}

/**
 * The sheet is an object with a non-empty `rows` list, every row is a list,
 * and every cell a scalar — Rust takes Vec<Vec<String>>.
 */
function sheetShapeError(raw: unknown, sheetNum: number): string | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return `Sheet ${sheetNum} is not an object. Each sheet is {"name": ..., "rows": [[...], ...]}.`;
	}
	const rows = (raw as { rows?: unknown }).rows;
	if (!Array.isArray(rows) || rows.length === 0) {
		return `Sheet ${sheetNum} has no rows. Pass the actual data — header row plus one row per record.`;
	}
	for (let r = 0; r < rows.length; r++) {
		const row = rows[r];
		if (!Array.isArray(row)) {
			return `Sheet ${sheetNum} row ${r + 1} is not an array. Each row is a list of cell values.`;
		}
		const c = row.findIndex((cell) => cell !== null && typeof cell === 'object');
		if (c !== -1) {
			return (
				`Sheet ${sheetNum} row ${r + 1} cell ${c + 1} is an object or list. ` +
				`Cells are text, numbers or booleans — put one value in each cell.`
			);
		}
	}
	return null;
}

/**
 * A lone `/word` row where a lone cell can't be a real row. In a
 * single-column sheet "/help" or "/etc" is data. Runs after sheetShapeError,
 * so every row is an array.
 */
function hasPlaceholderRow(rows: unknown[][]): boolean {
	return (
		rows[0].length > 1 &&
		rows.some((r) => r.length === 1 && typeof r[0] === 'string' && isPlaceholderText(r[0]))
	);
}

function validateSheet(raw: unknown, sheetNum: number): string | null {
	const shapeError = sheetShapeError(raw, sheetNum);
	if (shapeError) return shapeError;
	const rows = (raw as { rows: unknown[][] }).rows;
	const markupError = sheetMarkupError(rows, sheetNum);
	if (markupError) return markupError;

	const header = rows[0];
	const dataRows = rows.slice(1);

	const hasRealData = dataRows.some(
		(r) => Array.isArray(r) && r.some((cell) => !isBlankCell(cell))
	);
	if (!hasRealData) {
		return (
			`Sheet ${sheetNum} contains only a header row (or rows with no real cell data). ` +
			`Pass every data row you want written — the tool does not expand placeholders or templates.`
		);
	}

	if (hasPlaceholderRow(rows)) {
		return (
			`Sheet ${sheetNum} contains a placeholder-style row like ["/formula"] or ["/data"]. ` +
			`This tool does not expand directives — pass the literal cell values you want written.`
		);
	}

	if (Array.isArray(header) && header.length > 0) {
		const headerCols = header.length;

		// Column-count blowout. If header has N cols but a data row has
		// way more cells, the model crammed multiple rows of data into
		// one row (alternating value/blank/value/blank…). Reject so it
		// emits one row per record instead.
		for (let r = 0; r < dataRows.length; r++) {
			const row = dataRows[r];
			if (Array.isArray(row) && row.length > headerCols * 2 && row.length > headerCols + 4) {
				return (
					`Sheet ${sheetNum} data row ${r + 1} has ${row.length} cells but the header has ${headerCols}. ` +
					`Each data row must have one cell per header column — emit one row per record, not all records crammed into a single row.`
				);
			}
		}

		// Entirely-blank column. If the model named a header column but
		// every data row's cell for that column is blank, it's almost
		// certainly a scaffold awaiting fill-in. Skip the check for
		// columns whose header is itself blank (those are unlabeled
		// optional columns).
		for (let col = 0; col < headerCols; col++) {
			if (isBlankCell(header[col])) continue;
			const colHasData = dataRows.some(
				(row) => Array.isArray(row) && col < row.length && !isBlankCell(row[col])
			);
			if (!colHasData) {
				const headerName = String(header[col]).trim();
				return (
					`Sheet ${sheetNum} column "${headerName}" is entirely blank in every data row. ` +
					`Compute the values for that column first (e.g. via run_python) and pass them as actual cell strings — the tool does not fill them in for you.`
				);
			}
		}
	}

	return null;
}

function spreadsheetWriteExecutor() {
	return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecOutput> => {
		const choice = spreadsheetCommand(args.path);
		if ('error' in choice) return toolResult(toolError(choice.error));
		const sheets = normalizeSheets(args.sheets);
		const validationError = validateSheets(sheets);
		if (validationError) {
			return toolResult(toolError(validationError));
		}
		const workdir = fsWorkdir(ctx)!;
		return draftWrite(
			'fs_write_spreadsheet',
			SPREADSHEET,
			sheetSignature(sheets),
			choice.path,
			(relPath, overwrite) => invoke(choice.command, { workdir, relPath, sheets, overwrite }),
			ctx
		);
	};
}

/** What a revised spreadsheet keeps: its first sheet's header row and first record. */
function sheetSignature(sheets: unknown): string[] {
	const first: unknown = Array.isArray(sheets) ? sheets[0] : undefined;
	const rows = first && typeof first === 'object' ? (first as { rows?: unknown }).rows : undefined;
	if (!Array.isArray(rows)) return [];
	const header = Array.isArray(rows[0]) ? rows[0].map(normText).join('\t') : '';
	const record = Array.isArray(rows[1]) ? normText(rows[1][0]) : '';
	return [header, record];
}

/**
 * Reject empty or whitespace-only content for the text-based writers
 * (fs_write_text, fs_write_document). Without this guard the tool writes a zero-byte
 * file and reports success, which an unattended job has no way to
 * notice.
 */
function validateTextContent(args: Record<string, unknown>, label: string): string | null {
	const content = args.content;
	if (typeof content !== 'string' || content.trim().length === 0) {
		return (
			`${label} requires non-empty content. Compose the text (e.g. via run_python or directly) ` +
			`and pass it as the content argument — the tool does not generate content for you.`
		);
	}
	return null;
}

function textWriteExecutor(tool: string, commandFor: (path: unknown) => CommandChoice) {
	return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecOutput> => {
		const choice = commandFor(args.path);
		if ('error' in choice) return toolResult(toolError(choice.error));
		const err = validateTextContent(args, tool);
		if (err) return toolResult(toolError(err));
		if (tool === 'fs_write_document') return documentWrite(choice, args.content as string, ctx);
		return fsWriteWithConflictCheck(
			tool,
			choice.command,
			fsWorkdir(ctx)!,
			choice.path,
			{ content: args.content },
			ctx.filesWrittenThisTurn,
			writeOptions(ctx),
			// The Code tab shows each write as a diff against what was there.
			ctx.codeSessionId && tool === 'fs_write_text' ? (args.content as string) : undefined
		);
	};
}

/**
 * Write a document. One this turn created may be written again under the
 * same title, to revise it (`_drafts.ts`).
 */
function documentWrite(
	choice: { command: string; path: string },
	content: string,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const workdir = fsWorkdir(ctx)!;
	return draftWrite(
		'fs_write_document',
		DOCUMENT,
		[firstLine(content)],
		choice.path,
		(relPath, overwrite) => invoke(choice.command, { workdir, relPath, content, overwrite }),
		ctx
	);
}

/**
 * A write `_drafts.ts` keeps track of: when the turn wrote `path` already,
 * a revision (`kind`, by `signature`) may replace it.
 */
async function draftWrite(
	tool: string,
	kind: DraftKind,
	signature: string[],
	path: string,
	write: RawWrite,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const turn = ctx.filesWrittenThisTurn;
	const rewrite = turn.has(path) && mayRewriteDraft(turn, path, signature, kind);
	const send: RawWrite = async (relPath, overwrite) => {
		await write(relPath, overwrite);
		noteDraft(turn, relPath, signature, overwrite);
	};
	return fsWriteWithConflictCheck(
		tool,
		send,
		fsWorkdir(ctx)!,
		path,
		{},
		turn,
		draftOptions(writeOptions(ctx), path, rewrite, draftRewriteHint(turn, path, kind))
	);
}

/** A tracked write's options: a rewrite may replace the file, a refusal says how to revise. */
function draftOptions(
	opts: WriteOptions,
	path: string,
	rewrite: boolean,
	hint: string
): WriteOptions {
	return rewrite ? rewriting(opts, path) : { ...opts, repeatHint: hint };
}

/**
 * Shell-mode dispatch for fs_write_text. When the agent is running in
 * the Shell tab in Code mode, route to fs_write_text_absolute (no workdir,
 * accepts an absolute path). Falls back to the chat-mode executor otherwise
 * (the plain Shell assistant is read-only and never reaches here).
 */
function shellAwareWriteText() {
	const chat = textWriteExecutor('fs_write_text', (path) => ({
		command: IPC.fs_write_text,
		path: path as string
	}));
	return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecOutput> => {
		const rootErr = writeRootError(args.path, ctx);
		if (rootErr) return toolResult(toolError(rootErr));
		// Shell-CWD (absolute) dispatch only in Code mode (which allows edits).
		if (!(ctx.shellMode && ctx.codeMode)) return chat(args, ctx);
		const err = validateTextContent(args, 'fs_write_text');
		if (err) return toolResult(toolError(err));
		// The terminal may have walked off this machine (ssh, container). The
		// write would land locally while the model believes it edited the file
		// it is looking at, so refuse and point at the shell instead.
		const elsewhere = await localWriteBlocked('fs_write_text', ctx);
		if (elsewhere) return toolResult(toolError(elsewhere));
		// Resolve a bare/relative name against the shell's cwd so the model's
		// natural `snake_game.py` lands instead of erroring on the absolute
		// requirement.
		const path = resolveShellPath(args.path as string, ctx.shellCwd);
		const overwrite = (args.overwrite as boolean | undefined) ?? true;
		try {
			await invoke('fs_write_text_absolute', {
				path,
				content: args.content as string,
				overwrite,
				...wslDistroArg()
			});
			return toolResult(`Wrote ${path}`);
		} catch (e) {
			return toolResult(toolInvokeError('fs_write_text', e));
		}
	};
}

function shellAwareEditText() {
	return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecOutput> => {
		// Same confinement fs_write_text gets. Missing here until guided planning
		// started exposing this tool, which was safe only because no writeRoot
		// caller could reach it — an edit that escapes the root is exactly as
		// damaging as a write that does.
		const rootErr = writeRootError(args.path, ctx);
		if (rootErr) return toolResult(toolError(rootErr));
		if (ctx.shellMode && ctx.codeMode) {
			const elsewhere = await localWriteBlocked('fs_edit_text', ctx);
			if (elsewhere) return toolResult(toolError(elsewhere));
			const path = resolveShellPath(args.path as string, ctx.shellCwd);
			try {
				const r = await invoke<EditResult>('fs_edit_text_absolute', {
					path,
					oldStr: args.old_str as string,
					newStr: args.new_str as string,
					...wslDistroArg()
				});
				return toolResult(formatEditResult(path, r));
			} catch (e) {
				return toolResult(toolInvokeError('fs_edit_text', e));
			}
		}
		const path = args.path as string;
		try {
			const r = await invoke<EditResult>('fs_edit_text', {
				workdir: fsWorkdir(ctx),
				relPath: path,
				oldStr: args.old_str as string,
				newStr: args.new_str as string
			});
			const diag = await lintPythonIfApplicable(fsWorkdir(ctx), path);
			return toolResult(`${formatEditResult(path, r)}${diag}`);
		} catch (e) {
			return toolResult(toolInvokeError('fs_edit_text', e));
		}
	};
}

/** Every bullet with text is a placeholder. A "/help" among real bullets is
 *  just a bullet about a command. */
function onlyPlaceholderBullets(bullets: unknown): boolean {
	if (!Array.isArray(bullets)) return false;
	const texts = bullets
		.map(bulletText)
		.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
	return texts.length > 0 && texts.every(isPlaceholderText);
}

/**
 * Normalize and validate slide-deck input in one pass. Forgiving on
 * shape — `layout` is lowercased and its aliases mapped, string `bullets`
 * are split on newlines into an array, and a slide a layout can't draw
 * falls back to one that can (`settleLayout`). Still rejects obvious
 * scaffolds: zero slides, empty titles, and placeholder-style bullets.
 */
function prepareSlides(raw: unknown): { slides?: unknown[]; error?: string } {
	const slides = parseIfJsonArray(raw);
	if (!Array.isArray(slides) || slides.length === 0) {
		return { error: 'slides must be a non-empty array. Pass every slide you want in the deck.' };
	}
	const prepared: Record<string, unknown>[] = [];
	for (let i = 0; i < slides.length; i++) {
		const num = i + 1;
		const rawSlide = slides[i];
		if (!rawSlide || typeof rawSlide !== 'object') {
			return { error: `Slide ${num} is not an object. Each slide needs at least a title.` };
		}
		const slide = { ...(rawSlide as Record<string, unknown>) };
		if (typeof slide.title !== 'string' || slide.title.trim().length === 0) {
			return {
				error: `Slide ${num} has no title. Every slide must have a non-empty title string.`
			};
		}
		normalizeSlide(slide);
		const visualError = prepareVisuals(slide, num);
		if (visualError) return { error: visualError };

		const markupError = slideMarkupError(slide, num);
		if (markupError) return { error: markupError };

		if (onlyPlaceholderBullets(slide.bullets) || onlyPlaceholderBullets(slide.right)) {
			return {
				error:
					`Slide ${num} contains a placeholder-style bullet like "/content" or "/data". ` +
					`Pass the literal bullet text — the tool does not expand directives.`
			};
		}

		settleLayout(slide);
		prepared.push(slide);
	}
	return { slides: prepared };
}

/** Write a built .pptx: the deck is the raw body, and the rest go as headers. */
function pptxWrite(deck: Uint8Array, workdir: string): RawWrite {
	return (relPath, overwrite) =>
		invoke('fs_write_pptx', deck, {
			headers: {
				'x-workdir': encodeURIComponent(workdir),
				'x-rel-path': encodeURIComponent(relPath),
				'x-overwrite': String(overwrite)
			}
		});
}

function slidesWriteExecutor() {
	return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecOutput> => {
		const choice = slidesCommand(args.path);
		if ('error' in choice) return toolResult(toolError(choice.error));
		const { slides, error } = prepareSlides(args.slides);
		if (error) return toolResult(toolError(error));
		const deck = slides as Slide[];
		const workdir = fsWorkdir(ctx)!;
		const path = choice.path;
		const titles = deck.map((s) => s.title);
		const turn = ctx.filesWrittenThisTurn;
		// A deck the model was shown, or one the turn created, may be written
		// again to fix it, keeping its look unless it names another (preview.ts).
		const rewrite = turn.has(path) && mayRewrite(turn, path, titles);
		const look = deckLook(args, rewrite ? writtenLook(turn, path) : undefined);
		const { theme, orientation } = look;
		// The path the deck went to: the user may have kept the old file and
		// had it written beside it.
		let written = path;
		const write = async (send: RawWrite) => {
			const noted: RawWrite = async (relPath, overwrite) => {
				written = relPath;
				await send(relPath, overwrite);
				noteDeck(turn, relPath, titles, look, overwrite);
			};
			const out = await fsWriteWithConflictCheck(
				'fs_write_slides',
				noted,
				workdir,
				path,
				{},
				turn,
				draftOptions(writeOptions(ctx), path, rewrite, deckRewriteHint(turn, path))
			);
			if (rewrite && out.result.startsWith('Wrote:')) noteRewrite(turn, path);
			return attachPreview(out, ctx, workdir, written, titles, look);
		};
		if (choice.command !== IPC.fs_write_pptx) {
			const odp = foldForOdp(deck);
			const out = await write((relPath, overwrite) =>
				invoke(choice.command, { workdir, relPath, slides: odp.slides, orientation, overwrite })
			);
			const dropped = theme === 'light' ? odp.dropped : [...odp.dropped, 'the theme was not used'];
			if (out.result.startsWith('Wrote:') && dropped.length > 0) {
				out.result += `\n.odp is plainer than .pptx: ${dropped.join('; ')}.`;
			}
			return out;
		}
		// The .pptx is built here with PptxGenJS; Rust only writes it. A deck
		// whose text won't fit is refused here, before anything is written.
		let built: Uint8Array;
		try {
			built = await buildPptx(deck, orientation, await loadSlideImages(workdir, deck), theme);
		} catch (e) {
			return toolResult(toolInvokeError('fs_write_slides', e));
		}
		return write(pptxWrite(built, workdir));
	};
}

// --- Registration ---

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_text',
			description:
				'Create a new text file or overwrite an existing one. In Chat mode the path is relative to the working directory. In Shell mode an absolute path (e.g. "/etc/nginx/conf.d/site.conf") is preferred, but a relative path (e.g. "snake_game.py") is resolved against the current shell directory — writes only work if the user has enabled them in Settings → Shell. Use this for txt, md, csv, json, bash scripts, and other plain text formats. The content parameter is written verbatim to the file.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description:
							'File path. Chat mode: relative to the working directory. Shell mode: absolute path.'
					},
					content: {
						type: 'string',
						description: 'The full text content to write to the file.'
					},
					overwrite: {
						type: 'boolean',
						description:
							'Shell mode only: whether to overwrite an existing file (defaults to true). Ignored in Chat mode, where conflicts with existing files are resolved interactively by the user.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: shellAwareWriteText()
});

// One tool per content shape; the path's extension picks the format. These
// replaced seven per-format tools whose schemas were a third of Chat's tool
// list. Offered whether or not the Python sandbox is on; the system prompt
// steers the model here rather than to fpdf2 or python-pptx.
registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_document',
			description:
				"Create a Word (.docx), PDF (.pdf) or LibreOffice (.odt) document from markdown. The path's extension picks the format; use .odt only when the user asks for it.",
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path ending in .docx, .pdf or .odt.' },
					content: {
						type: 'string',
						description:
							'The whole document as markdown. Headings: # / ## / ###. Paragraphs separated by blank lines; prefer prose to bullet lists. Image: `![alt](path)` on its own line, a workdir-relative .png/.jpg/.jpeg/.gif; a title like `"center 50%"` sets alignment (left|center|right) and width (5–100%). PDF also renders bold, italic, code, `- ` lists and tables; .docx and .odt write other lines as plain paragraphs.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: textWriteExecutor('fs_write_document', documentCommand)
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_spreadsheet',
			description:
				'Create an Excel (.xlsx) or LibreOffice (.ods) spreadsheet. The path\'s extension picks the format; use .ods only when the user asks for it. Compute the data first (e.g. with run_python) and pass every row: the tool fills in nothing. Example: sheets=[{name:"Data",rows:[["N","F(N)"],["1","0"],["2","1"]]}].',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path ending in .xlsx or .ods.' },
					sheets: SHEETS_SCHEMA
				},
				required: ['path', 'sheets']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: spreadsheetWriteExecutor()
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_slides',
			description:
				"Create a PowerPoint (.pptx) or LibreOffice (.odp) slide deck. The path's extension picks the format; use .odp only when the user asks for it. Open with a cover, vary the layouts, and keep each slide to 3–6 short bullets. Pass numbers as a chart or table, not a picture of one.",
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path ending in .pptx or .odp.' },
					orientation: {
						type: 'string',
						enum: ['landscape', 'portrait'],
						description:
							'Pick from where the deck will be seen. "landscape" (16:9, default): a screen, projector or call. "portrait" (9:16): a phone, vertical screen or story; keep bullets short, and an image goes above them.'
					},
					theme: {
						type: 'string',
						enum: [...SLIDE_THEMES],
						description:
							'light (default), dark, bold (black, red), warm (cream, serif) or calm (green).'
					},
					slides: SLIDE_SCHEMA
				},
				required: ['path', 'slides']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: slidesWriteExecutor()
});

for (const [alias, { tool, ext }] of Object.entries(LEGACY_WRITE_TOOLS)) {
	registerToolAlias(alias, tool, withExtension(ext));
}

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_download_url',
			description:
				'Download a file from a URL into the working directory. 50 MB limit. Executable formats are blocked.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The HTTP(S) URL to download.' },
					path: {
						type: 'string',
						description:
							'Relative path (inside the working directory) where the downloaded file should be written. Include the file extension — it determines whether the download is allowed (e.g. images/hero.png is fine, installer.exe is blocked).'
					}
				},
				required: ['url', 'path']
			}
		}
	},
	displayLabel: (args) => {
		const path = (args.path as string) || '';
		const url = (args.url as string) || '';
		return path ? `${path} (${url})` : url;
	},
	async execute(args, ctx) {
		const url = ensureUrlScheme(args.url as string);
		const relPath = args.path as string;
		const resolved = await resolveWritePathInteractive(
			fsWorkdir(ctx)!,
			relPath,
			ctx.filesWrittenThisTurn,
			{ ...writeOptions(ctx), editable: false }
		);
		if (resolved.kind === 'canceled') return userCanceledWriteError(relPath, 'fs_download_url');
		if (resolved.kind === 'rejected') return toolResult(toolError(resolved.message));
		try {
			const message = await invoke<string>('fs_download_url', {
				workdir: fsWorkdir(ctx),
				url,
				relPath: resolved.finalPath,
				overwrite: resolved.overwrite
			});
			ctx.filesWrittenThisTurn.add(resolved.finalPath);
			if (ctx.codeSessionId) ctx.filesRewritableThisTurn?.delete(resolved.finalPath);
			let thumbDataUrl: string | undefined;
			if (IMAGE_EXT_RE.test(resolved.finalPath)) {
				try {
					thumbDataUrl = await invoke<string>('fs_read_image', {
						workdir: fsWorkdir(ctx),
						relPath: resolved.finalPath
					});
				} catch {
					// Thumbnail is best-effort
				}
			}
			return { result: message, thumbDataUrl };
		} catch (e) {
			return toolResult(toolInvokeError('fs_download_url', e));
		}
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_edit_text',
			description:
				'Edit a text file by replacing exactly one occurrence of old_str with new_str. The old_str must appear exactly once in the file — include enough surrounding context to make it unique. Use this for small targeted changes; for large rewrites use fs_write_text with overwrite. In Chat mode the path is relative to the working directory. In Shell mode an absolute path (e.g. "/etc/ssh/sshd_config") is preferred, but a relative path is resolved against the current shell directory; writes must be enabled in Settings → Shell.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description:
							'File path. Chat mode: relative to the working directory. Shell mode: absolute path.'
					},
					old_str: {
						type: 'string',
						description: 'The exact text to find and replace. Must be unique in the file.'
					},
					new_str: {
						type: 'string',
						description: 'The replacement text.'
					}
				},
				required: ['path', 'old_str', 'new_str']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: shellAwareEditText()
});
