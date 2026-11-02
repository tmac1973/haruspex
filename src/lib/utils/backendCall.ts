/**
 * One HTTP call to a server the user runs (ComfyUI, Lemonade, llama-toolchest,
 * ace-server), made from Rust and stoppable. Every backend's calls share one
 * cancel table in Rust, so an abort is `comfy_cancel` whichever command made
 * the call; a failure comes back as a `ComfyError`, which each backend turns
 * into its own error type through a {@link Backend}.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import type { ComfyError } from '#lib/ipc/gen/ComfyError.ts';
import type { IpcCommand } from '#lib/ipc/commands.ts';

/** Enough for any call but a generation, which passes its own. */
export const BACKEND_TIMEOUT_MS = 30_000;
/** A multipart upload: a song can be tens of megabytes; the job itself is only queued. */
export const BACKEND_UPLOAD_TIMEOUT_MS = 120_000;

/** How one backend names itself and words its errors. */
export interface Backend<E extends Error> {
	/** Starts each call's id: `comfy-3`. */
	prefix: string;
	/** In "The request to … failed". */
	server: string;
	cancelled: () => E;
	error: (kind: 'timeout' | 'unreachable' | 'rejected', message: string) => E;
	/** A refusal in the backend's own words. */
	rejected: (status: number, body: string, path: string) => E;
}

/** A `ComfyError` from Rust as `backend`'s error; anything else is an IPC failure or a raced cancel. */
export function fromBackendError<E extends Error>(
	backend: Backend<E>,
	e: unknown,
	path: string,
	signal?: AbortSignal
): E {
	const err = (e !== null && typeof e === 'object' && 'kind' in e ? e : null) as ComfyError | null;
	switch (err?.kind) {
		case 'cancelled':
			return backend.cancelled();
		case 'timeout':
		case 'unreachable':
			return backend.error(err.kind, err.message);
		case 'invalid':
			return backend.error('rejected', err.message);
		case 'rejected':
			return backend.rejected(err.status, err.body, path);
		default:
			if (signal?.aborted) return backend.cancelled();
			return backend.error(
				'unreachable',
				`The request to ${backend.server} failed — ${errMessage(e)}`
			);
	}
}

let nextId = 0;

/**
 * `invoke(command, args(id))`, stopped through `comfy_cancel` when `signal`
 * aborts. `path` names the call in an error.
 */
export async function invokeBackend<T, E extends Error>(
	backend: Backend<E>,
	command: IpcCommand,
	path: string,
	args: (id: string) => InvokeArgs,
	signal?: AbortSignal
): Promise<T> {
	if (signal?.aborted) throw backend.cancelled();
	const id = `${backend.prefix}-${++nextId}`;
	const onAbort = () => void invoke('comfy_cancel', { id }).catch(() => {});
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		return await invoke<T>(command, args(id));
	} catch (e) {
		throw fromBackendError(backend, e, path, signal);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}
