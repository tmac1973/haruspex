/**
 * Startup check that the Settings → Inference remote model still exists. A
 * remote model can be unloaded or renamed while the app is closed; without
 * this the first sign is a failed chat turn. The check only reports: it never
 * blocks startup and never changes the settings.
 */
import { probeInferenceServer } from '#lib/inferenceProbe.ts';
import { fetchOpenRouterCatalog, OPENROUTER_BASE_URL } from '#lib/openrouter.ts';
import type { InferenceBackendConfig } from '#lib/stores/settings.ts';
import { setRemoteProblem } from '#lib/stores/llamaServer.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { openSettings } from '#lib/stores/settingsNav.svelte.ts';

export type RemoteModelCheck =
	| { kind: 'ok' }
	/** The server answered, but its model list lacks the configured id. */
	| { kind: 'missing'; modelId: string }
	/** The server (or OpenRouter's catalog) did not answer. */
	| { kind: 'unreachable'; error: string };

type RemoteBackend = Pick<
	InferenceBackendConfig,
	'remoteBaseUrl' | 'remoteApiKeyId' | 'remoteApiKey' | 'remoteModelId'
>;

export function isOpenRouterUrl(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === new URL(OPENROUTER_BASE_URL).hostname;
	} catch {
		return false;
	}
}

/**
 * List the server's models and look for the configured id. OpenRouter's
 * public catalog is read directly (it sends CORS headers); every other
 * server goes through the Rust probe, since some, such as llama-toolchest,
 * send no CORS headers on `/v1/models`.
 */
export async function checkRemoteModel(backend: RemoteBackend): Promise<RemoteModelCheck> {
	const modelId = backend.remoteModelId.trim();
	let ids: string[];
	try {
		if (isOpenRouterUrl(backend.remoteBaseUrl)) {
			ids = (await fetchOpenRouterCatalog()).map((m) => m.id);
		} else {
			const probe = await probeInferenceServer(
				backend.remoteBaseUrl,
				backend.remoteApiKeyId,
				backend.remoteApiKey
			);
			ids = probe.models.map((m) => m.id);
		}
	} catch (e) {
		return { kind: 'unreachable', error: e instanceof Error ? e.message : String(e) };
	}
	return ids.includes(modelId) ? { kind: 'ok' } : { kind: 'missing', modelId };
}

/** `host:port`, or `OpenRouter`, for one-line messages. */
function serverName(baseUrl: string): string {
	if (isOpenRouterUrl(baseUrl)) return 'OpenRouter';
	try {
		const u = new URL(baseUrl);
		return u.port ? `${u.hostname}:${u.port}` : u.hostname;
	} catch {
		return baseUrl;
	}
}

/**
 * Run the check for the Settings → Inference remote backend and tell the
 * user when it fails: the header badge turns to an error that opens
 * Settings → Inference, and a toast says so once. Fire and forget.
 */
export async function checkRemoteModelOnStartup(backend: RemoteBackend): Promise<void> {
	const result = await checkRemoteModel(backend);
	const { remoteBaseUrl: baseUrl, remoteModelId: modelId } = backend;
	if (result.kind === 'ok') {
		setRemoteProblem(baseUrl, modelId, undefined);
		return;
	}
	if (!setRemoteProblem(baseUrl, modelId, result)) return;
	const server = serverName(baseUrl);
	const message =
		result.kind === 'missing'
			? `${server} no longer has the model ${result.modelId || '(none set)'}. Pick one in Settings → Inference.`
			: `Can't reach ${server}. Check Settings → Inference.`;
	showToast(message, {
		kind: 'error',
		actionLabel: 'Open Settings',
		onAction: () => openSettings('inference')
	});
}
