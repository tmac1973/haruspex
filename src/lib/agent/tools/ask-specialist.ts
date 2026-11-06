/**
 * `ask_specialist`: the Code tab's model hands a narrow job to a small model
 * tuned for it (Settings → Code → Specialists). Offered only when the session
 * has a specialist on (the header's Specialists menu). The schema is built
 * per turn from those specialists' kinds; the kind does the work
 * (`#lib/specialists/kinds/`).
 */
import type { ToolDefinition } from '#lib/api.ts';
import { assetIo } from '#lib/agent/tools/_assetIo.ts';
import { registerTool, type ToolSchemaOpts } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { effectiveDescription, specialistEntries } from '#lib/specialists/entries.ts';
import { specialistKind } from '#lib/specialists/kinds.ts';
import '#lib/specialists/kinds/index.ts';
import { sessionSpecialists } from '#lib/specialists/session.ts';
import type { SpecialistEntry, SpecialistImage, SpecialistKind } from '#lib/specialists/types.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { errMessage } from '#lib/utils/error.ts';
import { extOf, imageMime } from '#lib/utils/mime.ts';

export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The pictures a specialist takes. */
const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp'] as const;

/** The tool's own fields; everything else belongs to a kind. */
const OWN = new Set(['name', 'request', 'images']);

const BASE_SCHEMA: ToolDefinition = {
	type: 'function',
	function: {
		name: 'ask_specialist',
		description: 'Hand a narrow job to a small model tuned for it.',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Which specialist.' },
				request: {
					type: 'string',
					description: 'What to make or answer, in plain English; keep it short and specific.'
				}
			},
			required: ['name']
		}
	}
};

function kindOf(entry: SpecialistEntry): SpecialistKind {
	return specialistKind(entry.kind)!;
}

/** The specialists this session offers, without write kinds when it may not write. */
function offered(stored: string[] | null | undefined, readOnly: boolean): SpecialistEntry[] {
	return sessionSpecialists(stored ?? null).filter((e) => !(readOnly && kindOf(e).writes));
}

/** The schema for this turn's specialists, or null when there are none. */
export function specialistSchema(
	schema: ToolDefinition,
	opts: Pick<ToolSchemaOpts, 'codeSpecialists' | 'codeReadOnly'>
): ToolDefinition | null {
	const entries = offered(opts.codeSpecialists, opts.codeReadOnly ?? false);
	if (!entries.length) return null;
	const base = schema.function.parameters as {
		properties: Record<string, Record<string, unknown>>;
		required: string[];
	};
	const properties: Record<string, Record<string, unknown>> = {
		...base.properties,
		name: { ...base.properties.name, enum: entries.map((e) => e.name) }
	};
	// Kind params, each marked with the kinds it is for.
	const kinds = [...new Map(entries.map((e) => [e.kind, kindOf(e)])).values()];
	for (const kind of kinds) {
		for (const [param, spec] of Object.entries(kind.params)) {
			const users = kinds.filter((k) => k.params[param]).map((k) => k.label);
			const own = (spec.schema.description as string | undefined) ?? '';
			properties[param] ??= { ...spec.schema, description: `(${users.join(', ')} only) ${own}` };
		}
	}
	const seeing = entries.filter((e) => e.acceptsImages).map((e) => e.name);
	if (seeing.length) {
		properties.images = {
			type: 'array',
			items: { type: 'string' },
			maxItems: MAX_IMAGES,
			description: `(only ${seeing.join(', ')}) Reference images in the session folder (PNG, JPEG or WebP) to send with the request.`
		};
	}
	const required = kinds.every((k) => k.requestRequired) ? ['name', 'request'] : ['name'];
	const list = entries.map((e) => `- ${e.name}: ${effectiveDescription(e)}`).join('\n');
	return {
		...schema,
		function: {
			...schema.function,
			description: `${schema.function.description} Specialists in this session:\n${list}`,
			parameters: { ...base, properties, required }
		}
	};
}

/** The images as data URLs, or the refusal for the first one that can't go. */
async function readImages(
	paths: unknown,
	entry: SpecialistEntry,
	ctx: ToolContext
): Promise<SpecialistImage[] | string> {
	if (paths === undefined) return [];
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) {
		return 'images must be a list of paths.';
	}
	if (!paths.length) return [];
	if (!entry.acceptsImages) {
		return `${entry.name} doesn't take images. Turn on Accepts images in Settings → Code → Specialists if its server can.`;
	}
	if (paths.length > MAX_IMAGES) return `Send at most ${MAX_IMAGES} images.`;
	const io = assetIo(ctx);
	const images: SpecialistImage[] = [];
	for (const path of paths) {
		const mime = imageMime(extOf(path), IMAGE_TYPES);
		if (!mime) return `${path}: send a PNG, JPEG or WebP.`;
		let bytes: number[];
		try {
			bytes = await io.read(path);
		} catch (e) {
			return `Could not read ${path}: ${errMessage(e)}`;
		}
		if (bytes.length > MAX_IMAGE_BYTES) return `${path} is over 8 MB.`;
		images.push({ path, dataUrl: `data:${mime};base64,${bytesToBase64(new Uint8Array(bytes))}` });
	}
	return images;
}

/** Why the call can't go to `entry`'s kind as it stands, or null. */
function argsRefusal(
	entry: SpecialistEntry,
	args: Record<string, unknown>,
	request: string | undefined,
	ctx: ToolContext
): string | null {
	const kind = kindOf(entry);
	for (const key of Object.keys(args)) {
		if (!OWN.has(key) && !kind.params[key]) return `${key} doesn't apply to ${entry.name}.`;
	}
	for (const [param, spec] of Object.entries(kind.params)) {
		if (spec.required && args[param] === undefined) return `${entry.name} needs ${param}.`;
	}
	if (kind.requestRequired && !request) return `${entry.name} needs a request.`;
	if (kind.writes && ctx.codeReadOnly) return 'This session is read-only.';
	return null;
}

/** The named specialist, or the refusal that lists the session's. */
function findEntry(name: unknown, ctx: ToolContext): SpecialistEntry | string {
	const all = sessionSpecialists(ctx.codeSpecialists ?? null);
	const entry = all.find((e) => e.name === name);
	if (entry) return entry;
	return `No specialist named ${String(name)}. This session has: ${all.map((e) => e.name).join(', ')}.`;
}

async function executeAskSpecialist(args: Record<string, unknown>, ctx: ToolContext) {
	const entry = findEntry(args.name, ctx);
	if (typeof entry === 'string') return toolResult(toolError(entry));
	const kind = kindOf(entry);
	const request =
		typeof args.request === 'string' && args.request.trim() ? args.request.trim() : undefined;
	const refusal = argsRefusal(entry, args, request, ctx);
	if (refusal) return toolResult(toolError(refusal));
	const images = await readImages(args.images, entry, ctx);
	if (typeof images === 'string') return toolResult(toolError(images));
	// The folder's writer lease, held until the turn ends (`executeTool` does
	// this by name for the write tools; this one writes only for some kinds).
	const refused = kind.writes && ctx.codeWriteGuard ? await ctx.codeWriteGuard.acquire() : null;
	if (refused) return toolResult(toolError(refused));
	try {
		return await kind.run({ entry, request, images, args, ctx });
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') throw e;
		return toolResult(toolError(`${entry.name} failed: ${errMessage(e)}`));
	}
}

/** The tool card's label for a call. */
export function askSpecialistLabel(args: Record<string, unknown>): string {
	const entry = specialistEntries().find((e) => e.name === args.name);
	const custom = entry ? kindOf(entry).callLabel?.(entry, args) : null;
	if (custom) return custom;
	const request = typeof args.request === 'string' ? args.request.trim() : '';
	const short = request.length > 60 ? `${request.slice(0, 59)}…` : request;
	return `${String(args.name ?? 'Specialist')}: ${short}`;
}

registerTool({
	schema: BASE_SCHEMA,
	execute: executeAskSpecialist,
	displayLabel: askSpecialistLabel,
	category: 'specialist',
	liveSchema: specialistSchema
});
