/**
 * `make_asset`: the Shell assistant in code mode makes art for the project
 * it is working on — "a 32 px coin sprite in assets/" — and gets back a file
 * made the way the asset job makes one: transparent, cropped, sized,
 * palette-reduced and checked (`assets/single.ts`).
 *
 * A texture is drawn by code from a recipe the model writes, as the job draws
 * one (`assets/texture.ts`): it tiles by construction, takes a second, and
 * needs no image backend. Everything else needs one.
 *
 * Code mode only. Chat has `generate_image` for pictures; this is for a
 * project's files.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import {
	ctxCwd,
	ctxWslDistroArg,
	fsWorkdir,
	resolveShellPath,
	toolInvokeError
} from '#lib/agent/tools/_helpers.ts';
import { localWriteBlocked } from '#lib/agent/tools/nested-session.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { extractPalette } from '#lib/assets/normalize.ts';
import {
	DEFAULT_SIZE,
	makeSingleAsset,
	type SingleAssetInput,
	type SingleKind
} from '#lib/assets/single.ts';
import {
	MAX_VARIANTS,
	renderTexture,
	seedOf,
	textureFiles,
	tiledPreview,
	validateRecipe
} from '#lib/assets/texture.ts';
import { recipeGuide } from '#lib/agent/jobs/types/asset-generation/prompts.ts';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { pngDataUrl as dataUrl } from '#lib/utils/base64.ts';

const KINDS: SingleKind[] = ['sprite', 'icon', 'texture', 'image'];

/** A texture's edge when none is asked for: the tile its recipe is written for. */
const TEXTURE_SIZE = 32;

interface ParsedInput {
	asset: Omit<SingleAssetInput, 'palette'>;
	path: string;
	paletteFrom: string | null;
	/** A texture's recipe, unchecked; Rust's check comes next. */
	recipe: Record<string, unknown> | null;
	/** Every file a texture writes: the path, then its variants. */
	files: string[];
}

/** The call's arguments, or what is wrong with them. */
function parseInput(args: Record<string, unknown>): ParsedInput | string {
	const kind = KINDS.find((k) => k === args.kind);
	if (!kind) return `kind must be one of ${KINDS.join(', ')}.`;
	const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
	const path = typeof args.path === 'string' ? args.path.trim() : '';
	if (!prompt || !path) return 'make_asset needs "prompt" and "path".';
	const size = typeof args.size === 'number' && args.size > 0 ? Math.round(args.size) : undefined;
	const style = typeof args.style === 'string' ? args.style : undefined;
	const from = typeof args.palette_from === 'string' ? args.palette_from.trim() : '';
	const recipe = recipeArg(args.recipe);
	if (kind === 'texture' && !recipe) {
		return 'A texture is drawn from a recipe: pass "recipe" as described in its parameter.';
	}
	const files = textureFiles(path, args.variants);
	return { asset: { kind, prompt, size, style }, path, paletteFrom: from || null, recipe, files };
}

/** A texture's recipe as given, unchecked, or null when it is not an object. */
function recipeArg(r: unknown): ParsedInput['recipe'] {
	return r && typeof r === 'object' && !Array.isArray(r) ? (r as ParsedInput['recipe']) : null;
}

/**
 * Where `make_asset` reads and writes. A Code session's folder is its
 * boundary, as for `fs_write_text`: the workdir-relative commands refuse a
 * path outside it (a WSL one is reached through its distro's share). A
 * Shell turn writes wherever the shell is, through the absolute ones.
 */
interface AssetIo {
	read(path: string): Promise<number[]>;
	write(path: string, bytes: number[], overwrite: boolean, dryRun: boolean): Promise<void>;
}

function assetIo(ctx: ToolContext): AssetIo {
	const workdir = ctx.shellMode ? null : fsWorkdir(ctx);
	if (workdir) {
		return {
			read: (relPath) => invoke<number[]>('fs_read_bytes', { workdir, relPath }),
			write: (relPath, bytes, overwrite, dryRun) =>
				invoke('fs_write_bytes', { workdir, relPath, bytes, overwrite, dryRun })
		};
	}
	const distro = ctxWslDistroArg(ctx);
	return {
		read: (path) => invoke<number[]>('fs_read_bytes_absolute', { path, ...distro }),
		write: (path, bytes, overwrite, dryRun) =>
			invoke('fs_write_bytes_absolute', { path, bytes, overwrite, dryRun, ...distro })
	};
}

/** Where one call writes, and how. */
interface Target {
	/** The file, resolved against the shell's or session's folder. */
	path: string;
	overwrite: boolean;
	io: AssetIo;
	cwd: string | null;
}

/** The colours of an existing image, to draw a new one of the set in. */
async function paletteOf(path: string, io: AssetIo): Promise<number[]> {
	return extractPalette(new Uint8Array(await io.read(path)), 16);
}

/** Write (or with `dryRun`, check it could write) the PNG; the refusal, or null. */
async function writeAsset(
	path: string,
	bytes: Uint8Array,
	overwrite: boolean,
	dryRun: boolean,
	io: AssetIo
): Promise<string | null> {
	try {
		await io.write(path, Array.from(bytes), overwrite, dryRun);
		return null;
	} catch (e) {
		const msg = errMessage(e);
		return /exists/i.test(msg)
			? `${path} already exists. Choose another name, or pass overwrite: true.`
			: `Could not write ${path}: ${msg}`;
	}
}

/** A sprite, icon or picture, drawn by the image backend. */
async function paintAsset(input: ParsedInput, target: Target, ctx: ToolContext) {
	const { path, overwrite, io } = target;
	if (getSettings().imageBackendKind === 'none') {
		return toolResult(
			toolError(
				`A ${input.asset.kind} needs image generation: set one up in Settings → Image. ` +
					'A texture works without it.'
			)
		);
	}

	// Refuse a path it could not write before spending a minute drawing.
	const unwritable = await writeAsset(path, new Uint8Array(), overwrite, true, io);
	if (unwritable) return toolResult(toolError(unwritable));

	const palette = await paletteFor(input, target);
	if (typeof palette === 'string') return toolResult(palette);

	const started = Date.now();
	const tick = setInterval(
		() => ctx.onProgress?.(`Drawing… ${Math.round((Date.now() - started) / 1000)} s`),
		1000
	);
	let asset;
	try {
		ctx.onProgress?.('Drawing…');
		asset = await makeSingleAsset({ ...input.asset, palette }, { signal: ctx.signal });
	} catch (e) {
		if (e instanceof ImageBackendError && e.kind === 'cancelled') throw e;
		return toolResult(toolError(`Could not make it: ${errMessage(e)}`));
	} finally {
		clearInterval(tick);
	}

	const failed = await writeAsset(path, asset.bytes, overwrite, false, io);
	if (failed) return toolResult(toolError(failed));

	const url = dataUrl(asset.bytes);
	// So the assistant can look at what it made, and redo it if it's wrong.
	if (ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES) {
		ctx.pendingImages.push({ path, dataUrl: url });
	}
	return toolResult(
		[
			`Wrote ${path} (${asset.width}×${asset.height}, ${asset.model}, seed ${asset.seed}).`,
			asset.checks.passed
				? 'It passed its checks.'
				: `It failed these checks: ${asset.checks.failed.join(', ')} — look at it and decide whether to redo it.`,
			...asset.notes
		].join(' '),
		url
	);
}

/**
 * The colours of palette_from, undefined when none was named, or the error
 * to return when it could not be read.
 */
async function paletteFor(
	input: ParsedInput,
	target: Target
): Promise<number[] | undefined | string> {
	if (!input.paletteFrom) return undefined;
	try {
		return await paletteOf(resolveShellPath(input.paletteFrom, target.cwd), target.io);
	} catch (e) {
		return toolInvokeError('make_asset palette_from', e);
	}
}

/**
 * A texture drawn by code from the model's recipe: every variant written,
 * and the base shown back laid 3×3, so the model sees what repeats.
 */
async function makeTexture(input: ParsedInput, target: Target, ctx: ToolContext) {
	const { path, overwrite, io } = target;
	const refused = await validateRecipe(input.recipe);
	if (refused) return toolResult(toolError(`The recipe was refused: ${refused}`));

	const paths = input.files.map((f) => resolveShellPath(f, target.cwd));
	for (const p of paths) {
		const unwritable = await writeAsset(p, new Uint8Array(), overwrite, true, io);
		if (unwritable) return toolResult(toolError(unwritable));
	}
	const palette = await paletteFor(input, target);
	if (typeof palette === 'string') return toolResult(palette);

	const size = input.asset.size ?? TEXTURE_SIZE;
	let tiles: Uint8Array[];
	try {
		// Seeded from the path, so a revised recipe moves only what it changed.
		const recipe = input.recipe as unknown as TextureRecipe;
		tiles = await renderTexture(recipe, size, seedOf(path), paths.length, palette ?? []);
	} catch (e) {
		return toolResult(toolError(`Could not draw it: ${errMessage(e)}`));
	}
	for (const [k, bytes] of tiles.entries()) {
		const failed = await writeAsset(paths[k], bytes, overwrite, false, io);
		if (failed) return toolResult(toolError(failed));
	}

	const url = dataUrl(await tiledPreview(tiles[0], size));
	const sees = ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES;
	if (sees) ctx.pendingImages.push({ path, dataUrl: url });
	return toolResult(
		[
			`Wrote ${paths.join(', ')} (${size}×${size}, drawn from the recipe).`,
			...(sees
				? [
						'The image shows the first laid 3×3, as a map lays it. If a line or a spot sits ' +
							'in the same place in every copy, take it out of the recipe and draw again ' +
							'with overwrite: true.'
					]
				: [])
		].join(' '),
		url
	);
}

registerTool({
	category: 'image',
	schema: {
		type: 'function',
		function: {
			name: 'make_asset',
			description:
				'Make an image file for the project: a sprite, icon or tiling texture made the way a game ' +
				'asset should be (transparent background, cropped, sized, reduced to a palette), or a ' +
				'plain picture. A texture is drawn by code from your recipe in a second; the rest use ' +
				'the image generation in Settings → Image and take 30 s to a few minutes. Pass ' +
				'palette_from with an existing asset to keep a set consistent.',
			parameters: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: KINDS, description: 'What to make.' },
					prompt: {
						type: 'string',
						description: 'The subject, in a short phrase: "a gold coin", "mossy cobblestones".'
					},
					path: {
						type: 'string',
						description:
							'Where to write the PNG, relative to the current directory or absolute. Its folder must exist.'
					},
					size: {
						type: 'number',
						description: `Target edge in px (sprite ${DEFAULT_SIZE.sprite}, icon ${DEFAULT_SIZE.icon}, texture ${TEXTURE_SIZE} by default; a texture's is a multiple of 4 from 8 to 256). Use the size the project uses.`
					},
					recipe: {
						type: 'object',
						description:
							'Texture only, and required for one: how code draws it. ' + recipeGuide().join('\n')
					},
					variants: {
						type: 'number',
						description: `Texture only: tiles to write, 1–${MAX_VARIANTS}, default 1. The same material with its details moved, to mix on a map; the second is <name>_1.png.`
					},
					style: {
						type: 'string',
						description: 'One line of style, e.g. "16-bit pixel art, dark outlines".'
					},
					palette_from: {
						type: 'string',
						description: "An existing image whose colours to draw in, to match a set's palette."
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' }
				},
				required: ['kind', 'prompt', 'path']
			}
		}
	},
	displayLabel: (args) => `make ${String(args.kind ?? 'asset')}: ${String(args.path ?? '')}`,
	execute: async (args, ctx) => {
		const input = parseInput(args);
		if (typeof input === 'string') return toolResult(toolError(input));

		// The terminal may have walked off this machine (ssh, a container): the
		// file would land here while the model thinks it is over there.
		const elsewhere = await localWriteBlocked('make_asset', ctx);
		if (elsewhere) return toolResult(toolError(elsewhere));
		// Relative to the shell's folder, or in the Code tab the session's.
		const cwd = ctxCwd(ctx);
		const path = resolveShellPath(input.path, cwd);
		const target = { path, overwrite: args.overwrite === true, io: assetIo(ctx), cwd };
		return input.asset.kind === 'texture'
			? makeTexture(input, target, ctx)
			: paintAsset(input, target, ctx);
	}
});
