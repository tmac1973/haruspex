/**
 * Reading and writing for `make_asset`: where its files go, and how a write
 * is refused before anything is drawn.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import {
	ctxWslDistroArg,
	fsWorkdir,
	resolveShellPath,
	toolInvokeError
} from '#lib/agent/tools/_helpers.ts';
import { extractPalette } from '#lib/assets/normalize.ts';

/**
 * Where `make_asset` reads and writes. A Code session's folder is its
 * boundary, as for `fs_write_text`: the workdir-relative commands refuse a
 * path outside it (a WSL one is reached through its distro's share). A
 * Shell turn writes wherever the shell is, through the absolute ones.
 */
export interface AssetIo {
	read(path: string): Promise<number[]>;
	write(path: string, bytes: number[], overwrite: boolean, dryRun: boolean): Promise<void>;
}

export function assetIo(ctx: ToolContext): AssetIo {
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
export interface Target {
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
export async function writeAsset(
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

/**
 * The colours of `paletteFrom`, undefined when none was named, or the error
 * to return when it could not be read.
 */
export async function paletteFor(
	paletteFrom: string | null,
	target: Target
): Promise<number[] | undefined | string> {
	if (!paletteFrom) return undefined;
	try {
		return await paletteOf(resolveShellPath(paletteFrom, target.cwd), target.io);
	} catch (e) {
		return toolInvokeError('make_asset palette_from', e);
	}
}
