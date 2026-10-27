/**
 * Saving what Haruspex made, a picture or a song, into the turn's folder:
 * `generate_image` and `generate_music` with a `path`, and `save_generated`
 * for one made earlier. The bytes come from the image or audio cache.
 *
 * Where it goes decides how it is written:
 *
 * - **A Code session** writes into its project as `make_asset` does: a dry
 *   run first, and an existing file replaced only with `overwrite`.
 * - **Chat** writes into its working folder as its other file tools do: an
 *   existing file asks the user (Overwrite / Keep both / Cancel) through
 *   `resolveWritePathInteractive`, whatever the model passed.
 *
 * Either way the target is settled before a generation starts, so a bad
 * path, or a user who cancels, costs no GPU minutes.
 */
import { invoke } from '@tauri-apps/api/core';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { ctxCwd, fsWorkdir, resolveShellPath } from '#lib/agent/tools/_helpers.ts';
import { assetIo, writeAsset } from '#lib/agent/tools/_assetIo.ts';
import { resolveWritePathInteractive, userCanceledWriteError } from '#lib/agent/tools/fs-write.ts';
import { audioHashFromUrl } from '#lib/audio/url.ts';
import { imageHashFromUrl } from '#lib/images/url.ts';
import { errMessage } from '#lib/utils/error.ts';

/** Something Haruspex made, by its cache URL. */
export interface Generated {
	kind: 'image' | 'audio';
	hash: string;
}

/** The picture or song a cache URL names, or null for any other URL. */
export function generatedFromUrl(url: string): Generated | null {
	const image = imageHashFromUrl(url);
	if (image) return { kind: 'image', hash: image };
	const audio = audioHashFromUrl(url);
	return audio ? { kind: 'audio', hash: audio } : null;
}

/** Its bytes from the cache. Throws when the cache no longer has it. */
export async function generatedBytes(g: Generated): Promise<Uint8Array> {
	const command = g.kind === 'image' ? 'image_read_bytes' : 'audio_read_bytes';
	return new Uint8Array(await invoke<ArrayBuffer>(command, { hash: g.hash }));
}

/** Where a save goes, once settled. */
export type SaveTarget =
	| { mode: 'project'; path: string; overwrite: boolean }
	| { mode: 'chat'; workdir: string; path: string; overwrite: boolean };

/** Why nothing can be saved in this turn, or null. */
function saveRefusal(ctx: ToolContext): string | null {
	if (ctx.codeReadOnly) return "This Code session is read-only; it can't save files.";
	if (!ctx.workingDir || ctx.shellMode) {
		return 'There is no folder to save into. In Chat, the user picks one with the folder button.';
	}
	return null;
}

/**
 * Settle where `rawPath` saves, asking the user in Chat if the file exists.
 * Returns the target, or the tool's answer when there is nothing to write.
 */
export async function prepareSave(
	rawPath: string,
	overwrite: boolean,
	ctx: ToolContext,
	tool: string
): Promise<SaveTarget | ToolExecOutput> {
	const refusal = saveRefusal(ctx);
	if (refusal) return toolResult(toolError(refusal));
	if (ctx.codeSessionId) {
		const path = resolveShellPath(rawPath, ctxCwd(ctx));
		const unwritable = await writeAsset(path, new Uint8Array(), overwrite, true, assetIo(ctx));
		return unwritable ? toolResult(toolError(unwritable)) : { mode: 'project', path, overwrite };
	}
	const workdir = fsWorkdir(ctx)!;
	const resolved = await resolveWritePathInteractive(workdir, rawPath, ctx.filesWrittenThisTurn, {
		askBeforeOverwrite: true,
		releaseSlot: ctx.releaseSlot
	});
	if (resolved.kind === 'canceled') return userCanceledWriteError(rawPath, tool);
	if (resolved.kind === 'rejected') return toolResult(toolError(resolved.message));
	return { mode: 'chat', workdir, path: resolved.finalPath, overwrite: resolved.overwrite };
}

export function isSaveTarget(v: SaveTarget | ToolExecOutput): v is SaveTarget {
	return 'mode' in v;
}

/**
 * Write a picture from the image cache to a settled target, by hash; the
 * refusal, or null. Rust reads and writes it (`fs_save_cached_image`), so a
 * large one, an upscale of 20 MB or more, never crosses the bridge and isn't
 * held to the cap on what a model writes.
 */
export async function writeCachedImage(
	target: SaveTarget,
	hash: string,
	ctx: ToolContext
): Promise<string | null> {
	const workdir = target.mode === 'chat' ? target.workdir : fsWorkdir(ctx);
	if (!workdir) return `Could not write ${target.path}: there is no folder to save into.`;
	try {
		await invoke('fs_save_cached_image', {
			hash,
			workdir,
			relPath: target.path,
			overwrite: target.overwrite
		});
		ctx.filesWrittenThisTurn.add(target.path);
		return null;
	} catch (e) {
		return `Could not write ${target.path}: ${errMessage(e)}`;
	}
}

/** Write the bytes to a settled target; the refusal, or null. */
export async function writeSaved(
	target: SaveTarget,
	bytes: Uint8Array,
	ctx: ToolContext
): Promise<string | null> {
	if (target.mode === 'project') {
		return writeAsset(target.path, bytes, target.overwrite, false, assetIo(ctx));
	}
	try {
		await invoke('fs_write_bytes', {
			workdir: target.workdir,
			relPath: target.path,
			bytes: Array.from(bytes),
			overwrite: target.overwrite,
			dryRun: false
		});
		ctx.filesWrittenThisTurn.add(target.path);
		return null;
	} catch (e) {
		return `Could not write ${target.path}: ${errMessage(e)}`;
	}
}
