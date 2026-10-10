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
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from './registry';
import { toolError, toolResult, type ToolContext } from './types';
import { ctxCwd, ctxWslDistroArg, fsWorkdir, resolveShellPath, toolInvokeError } from './_helpers';
import { localWriteBlocked } from './nested-session';
import { MAX_PENDING_IMAGES } from './fs-read';
import { extractPalette } from '#lib/assets/normalize.ts';
import {
	DEFAULT_SIZE,
	makeSingleAsset,
	type SingleAssetInput,
	type SingleKind
} from '#lib/assets/single.ts';
import { ImageBackendError } from '#lib/image/types.ts';

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
		// Relative to the shell's folder, or in the Code tab the session's.
		const cwd = ctxCwd(ctx);
		const io = assetIo(ctx);
		const path = resolveShellPath(input.path, cwd);
		const overwrite = args.overwrite === true;

		// Refuse a path it could not write before spending a minute drawing.
		const unwritable = await writeAsset(path, new Uint8Array(), overwrite, true, io);
		if (unwritable) return toolResult(toolError(unwritable));

		let palette: number[] | undefined;
		if (input.paletteFrom) {
			try {
				palette = await paletteOf(resolveShellPath(input.paletteFrom, cwd), io);
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
});
