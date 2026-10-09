/**
 * Swapping the `remote*` settings between the generic Remote option and the
 * OpenRouter option in Settings → Inference.
 *
 * Both run as `mode: 'remote'` and read the same fields, so before this each
 * switch carried the other's server, key and model across: pick an OpenRouter
 * key, go back to Remote, and your own server was sent the OpenRouter key.
 */
import { OPENROUTER_BASE_URL } from '#lib/openrouter.ts';
import type { InferenceBackendConfig, RemoteProfile } from './settings';

export type RemoteOption = 'generic' | 'openrouter';

/** Which option the `remote*` fields currently belong to (in local mode too). */
export function currentRemoteOption(cfg: InferenceBackendConfig): RemoteOption {
	return cfg.remoteBackendKind === 'openrouter' ? 'openrouter' : 'generic';
}

function profileOf(cfg: InferenceBackendConfig): RemoteProfile {
	return {
		remoteBaseUrl: cfg.remoteBaseUrl,
		remoteApiKey: cfg.remoteApiKey,
		remoteApiKeyId: cfg.remoteApiKeyId,
		remoteModelId: cfg.remoteModelId,
		remoteContextSize: cfg.remoteContextSize,
		remoteVisionSupported: cfg.remoteVisionSupported,
		remoteBackendKind: cfg.remoteBackendKind,
		remoteSampling: cfg.remoteSampling,
		remoteReasoning: cfg.remoteReasoning,
		remoteParallel: cfg.remoteParallel,
		allowParallelInference: cfg.allowParallelInference
	};
}

/** An option never used before: no key, no model, nothing probed. */
function freshProfile(cfg: InferenceBackendConfig, option: RemoteOption): RemoteProfile {
	const empty = {
		remoteApiKey: '',
		remoteApiKeyId: null,
		remoteModelId: '',
		remoteContextSize: null,
		remoteVisionSupported: null,
		remoteSampling: null,
		remoteReasoning: null,
		remoteParallel: null
	};
	if (option === 'openrouter') {
		return {
			...empty,
			remoteBaseUrl: OPENROUTER_BASE_URL,
			remoteBackendKind: 'openrouter',
			allowParallelInference: true
		};
	}
	return {
		...empty,
		// The first saved server, so the form opens on something the user added.
		remoteBaseUrl: cfg.remoteServerUrls.find((u) => !u.includes('openrouter.ai')) ?? '',
		remoteBackendKind: null,
		allowParallelInference: false
	};
}

/**
 * `cfg` with the `remote*` fields belonging to `target`: the current ones are
 * filed under their own option and `target`'s saved ones (or a fresh set) put
 * in their place. Unchanged when they already belong to `target`. Does not
 * touch `mode`.
 */
export function withRemoteOption(
	cfg: InferenceBackendConfig,
	target: RemoteOption
): InferenceBackendConfig {
	const current = currentRemoteOption(cfg);
	if (current === target) return cfg;
	const remoteProfiles = { ...cfg.remoteProfiles, [current]: profileOf(cfg) };
	const incoming = remoteProfiles[target] ?? freshProfile(cfg, target);
	return { ...cfg, ...incoming, remoteProfiles };
}
