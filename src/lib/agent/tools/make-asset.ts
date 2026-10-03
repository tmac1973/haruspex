/**
 * `make_asset`: the Shell assistant in code mode makes art for the project
 * it is working on — "a 32 px coin sprite in assets/" — and gets back a file
 * made the way the asset job makes one: transparent, cropped, sized,
 * palette-reduced and checked (`assets/single.ts`).
 *
 * Code mode only, and only with an image backend. Chat has `generate_image`
 * for pictures; this is for a project's files.
 */
import { invoke } from '@tauri-apps/api/core';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';
import { resolveShellPath, toolInvokeError, wslDistroArg } from './_helpers';
import { localWriteBlocked } from './nested-session';
import { MAX_PENDING_IMAGES } from './fs-read';
import { extractPalette } from '$lib/assets/normalize';
import {
	DEFAULT_SIZE,
	makeSingleAsset,
	type SingleAssetInput,
	type SingleKind
} from '$lib/assets/single';
import { ImageBackendError } from '$lib/image/types';

const KINDS: SingleKind[] = ['sprite', 'icon', 'texture', 'image'];

function dataUrl(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return `data:image/png;base64,${btoa(s)}`;
}

interface ParsedInput {
	asset: Omit<SingleAssetInput, 'palette'>;
	path: string;
	paletteFrom: string | null;
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
	return { asset: { kind, prompt, size, style }, path, paletteFrom: from || null };
}

/** The colours of an existing image, to draw a new one of the set in. */
async function paletteOf(path: string): Promise<number[]> {
	const bytes = await invoke<number[]>('fs_read_bytes_absolute', { path, ...wslDistroArg() });
	return extractPalette(new Uint8Array(bytes), 16);
}

/** Write (or with `dryRun`, check it could write) the PNG; the refusal, or null. */
async function writeAsset(
	path: string,
	bytes: Uint8Array,
	overwrite: boolean,
	dryRun: boolean
): Promise<string | null> {
	try {
		await invoke('fs_write_bytes_absolute', {
			path,
			bytes: Array.from(bytes),
			overwrite,
			dryRun,
			...wslDistroArg()
		});
		return null;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return /exists/i.test(msg)
			? `${path} already exists. Choose another name, or pass overwrite: true.`
			: `Could not write ${path}: ${msg}`;
	}
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
				'plain picture. Uses the image generation in Settings → Image; takes 30 s to a few ' +
				'minutes. Pass palette_from with an existing asset to keep a set consistent.',
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
						description: `Target edge in px (sprite ${DEFAULT_SIZE.sprite}, icon ${DEFAULT_SIZE.icon}, texture ${DEFAULT_SIZE.texture} by default). Use the size the project uses.`
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
		const path = resolveShellPath(input.path, ctx.shellCwd);
		const overwrite = args.overwrite === true;

		// Refuse a path it could not write before spending a minute drawing.
		const unwritable = await writeAsset(path, new Uint8Array(), overwrite, true);
		if (unwritable) return toolResult(toolError(unwritable));

		let palette: number[] | undefined;
		if (input.paletteFrom) {
			try {
				palette = await paletteOf(resolveShellPath(input.paletteFrom, ctx.shellCwd));
			} catch (e) {
				return toolResult(toolInvokeError('make_asset palette_from', e));
			}
		}

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
			return toolResult(
				toolError(`Could not make it: ${e instanceof Error ? e.message : String(e)}`)
			);
		} finally {
			clearInterval(tick);
		}

		const failed = await writeAsset(path, asset.bytes, overwrite, false);
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
});
