/**
 * The models a Code session can pick in its header. Null is "whatever
 * Settings uses"; anything else is a remote `BackendOverride` (overrides are
 * remote-only: the local model is global, because swapping it restarts
 * llama-server under every session).
 */
import type { BackendOverride } from '#lib/api.ts';
import type { AppSettings } from '#lib/stores/settings.ts';
import { folderName } from '#lib/code/sessionList.ts';

export interface BackendChoice {
	/** Stable select value. */
	key: string;
	label: string;
	title: string;
	backend: BackendOverride | null;
}

export const SETTINGS_KEY = 'settings';

/** Select value for a backend; the same server and model give the same key. */
export function backendKey(b: BackendOverride | null): string {
	if (!b) return SETTINGS_KEY;
	return `${b.baseUrl.replace(/\/+$/, '')}|${b.modelId ?? ''}`;
}

function host(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return folderName(url);
	}
}

/** What the global backend is, for the "Settings" option's label. */
export function settingsBackendLabel(settings: AppSettings): string {
	const inf = settings.inferenceBackend;
	if (inf.mode === 'remote' && inf.remoteBaseUrl) {
		return inf.remoteModelId || host(inf.remoteBaseUrl);
	}
	return 'local model';
}

/**
 * Settings' model, the remote server saved in Settings → Inference when
 * Settings is on the local model, and the session's own choice if it is
 * neither (picked when Settings looked different).
 */
export function backendChoices(
	settings: AppSettings,
	current: BackendOverride | null
): BackendChoice[] {
	const choices: BackendChoice[] = [
		{
			key: SETTINGS_KEY,
			label: `Settings (${settingsBackendLabel(settings)})`,
			title: 'Follows Settings → Inference.',
			backend: null
		}
	];
	const inf = settings.inferenceBackend;
	if (inf.mode !== 'remote' && inf.remoteBaseUrl.trim() && inf.remoteModelId.trim()) {
		const remote: BackendOverride = {
			baseUrl: inf.remoteBaseUrl.trim(),
			modelId: inf.remoteModelId.trim(),
			apiKeyId: inf.remoteApiKeyId ?? undefined,
			apiKey: inf.remoteApiKey || undefined,
			contextSize: inf.remoteContextSize,
			visionSupported: inf.remoteVisionSupported,
			discovered: { reasoning: inf.remoteReasoning, sampling: inf.remoteSampling }
		};
		choices.push({
			key: backendKey(remote),
			label: `${remote.modelId} (${host(remote.baseUrl)})`,
			title: `The remote server saved in Settings → Inference: ${remote.baseUrl}`,
			backend: remote
		});
	}
	if (current && !choices.some((c) => c.key === backendKey(current))) {
		choices.push({
			key: backendKey(current),
			label: `${current.modelId || 'default'} (${host(current.baseUrl)})`,
			title: `This session's model: ${current.baseUrl}`,
			backend: current
		});
	}
	return choices;
}
