/**
 * Calls to a llama-toolchest server, made from Rust (`toolchest_json`,
 * `toolchest_bytes`) for the reasons the ComfyUI client gives: no `Origin`,
 * no proxy, one cancel table. Shared by the image, music and video backends;
 * image and music turn a {@link ToolchestError} into their own error type.
 */

import { BACKEND_UPLOAD_TIMEOUT_MS, invokeBackend, type Backend } from '#lib/utils/backendCall.ts';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { toolchestCall } from '#lib/toolchest/models.ts';

export interface ToolchestConfig {
	baseUrl: string;
	apiKey: string;
}

/** As the image and music backends' kinds, which take these over unchanged. */
export type ToolchestErrorKind =
	'unconfigured' | 'unreachable' | 'timeout' | 'rejected' | 'cancelled';

export class ToolchestError extends Error {
	readonly kind: ToolchestErrorKind;
	readonly status?: number;
	/** Toolchest's own `error.code`, such as `queue_full` or `not_ready`. */
	readonly code?: string;

	constructor(
		kind: ToolchestErrorKind,
		message: string,
		opts: { status?: number; code?: string } = {}
	) {
		super(message);
		this.name = 'ToolchestError';
		this.kind = kind;
		this.status = opts.status;
		this.code = opts.code;
	}
}

/** Toolchest's `{"error":{"message","code"}}`, when a refusal has one. */
export function errorBody(body: string): { message: string | null; code: string | null } {
	try {
		const e = (JSON.parse(body) as { error?: { message?: unknown; code?: unknown } })?.error;
		return {
			message: typeof e?.message === 'string' && e.message ? e.message : null,
			code: typeof e?.code === 'string' && e.code ? e.code : null
		};
	} catch {
		return { message: null, code: null };
	}
}

/** A refusal in a sentence: the key, a full queue, or toolchest's own message. */
function fromRefusal(status: number, body: string, path: string): ToolchestError {
	const { message, code } = errorBody(body);
	const opts = { status, code: code ?? undefined };
	if (status === 401) {
		return new ToolchestError('rejected', 'llama-toolchest refused the API key.', opts);
	}
	if (code === 'queue_full') {
		return new ToolchestError(
			'rejected',
			"llama-toolchest's queue is full; try again in a minute.",
			opts
		);
	}
	return new ToolchestError(
		'rejected',
		`llama-toolchest refused ${path}: ${message ?? `status ${status}`}`,
		opts
	);
}

const toolchest: Backend<ToolchestError> = {
	prefix: 'toolchest',
	server: 'llama-toolchest',
	cancelled: () => new ToolchestError('cancelled', 'Cancelled.'),
	error: (kind, message) => new ToolchestError(kind, message),
	rejected: fromRefusal
};

function call<T>(
	command: 'toolchest_json' | 'toolchest_bytes' | 'toolchest_upload',
	cfg: ToolchestConfig,
	req: { method?: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown; timeoutMs?: number },
	signal?: AbortSignal,
	files?: UploadFile[],
	fields?: boolean
): Promise<T> {
	return invokeBackend<T, ToolchestError>(
		toolchest,
		command,
		req.path,
		(id) => ({
			call: toolchestCall(
				cfg.baseUrl,
				cfg.apiKey,
				req.method ?? 'GET',
				req.path,
				req.body,
				req.timeoutMs,
				id
			),
			...(files ? { files } : {}),
			...(fields ? { fields } : {})
		}),
		signal
	);
}

export function toolchestJson(
	cfg: ToolchestConfig,
	req: { method?: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown; timeoutMs?: number },
	signal?: AbortSignal
): Promise<unknown> {
	return call<unknown>('toolchest_json', cfg, req, signal);
}

/**
 * A multipart POST: `body` in a `request` part and each file in its own; with
 * `fields`, each of `body`'s fields in a text part of its own instead, the
 * form `/v1/images/edits` takes.
 */
export function toolchestUpload(
	cfg: ToolchestConfig,
	req: { path: string; body: unknown; timeoutMs?: number },
	files: UploadFile[],
	signal?: AbortSignal,
	fields = false
): Promise<unknown> {
	const timeoutMs = req.timeoutMs ?? BACKEND_UPLOAD_TIMEOUT_MS;
	return call<unknown>(
		'toolchest_upload',
		cfg,
		{ ...req, method: 'POST', timeoutMs },
		signal,
		files,
		fields
	);
}

export async function toolchestBytes(
	cfg: ToolchestConfig,
	path: string,
	signal?: AbortSignal
): Promise<Uint8Array> {
	const buf = await call<ArrayBuffer | number[]>('toolchest_bytes', cfg, { path }, signal);
	return buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf);
}

/** The host a base URL names, for a sentence. */
export function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host || baseUrl;
	} catch {
		return baseUrl;
	}
}
