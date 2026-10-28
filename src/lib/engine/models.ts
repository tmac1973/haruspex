/**
 * The models a client can point a Code session at (#744): what Settings →
 * Inference has active, the saved remote options, the API keys by name, and
 * a server's model list, as the model pickers read it. Keys never cross:
 * a session or a probe names one by its id.
 */
import { settingsModelName } from '#lib/code/backends.ts';
import { probeInferenceServer } from '#lib/inferenceProbe.ts';
import { getApiKeys, getSettings, type RemoteProfile } from '#lib/stores/settings.ts';
import type { ModelsOp } from '#lib/engine/types.ts';

const profileOut = (p: RemoteProfile | undefined) =>
	p && {
		baseUrl: p.remoteBaseUrl,
		modelId: p.remoteModelId,
		apiKeyId: p.remoteApiKeyId ?? null,
		contextSize: p.remoteContextSize ?? null
	};

export async function dispatchModels(op: ModelsOp): Promise<unknown> {
	switch (op.type) {
		case 'models.list': {
			const s = getSettings();
			const inf = s.inferenceBackend;
			return {
				settings: {
					mode: inf.mode,
					model: settingsModelName(s),
					baseUrl: inf.mode === 'remote' ? inf.remoteBaseUrl : null,
					modelId: inf.mode === 'remote' ? inf.remoteModelId : null,
					apiKeyId: inf.mode === 'remote' ? inf.remoteApiKeyId : null
				},
				profiles: {
					generic: profileOut(inf.remoteProfiles?.generic) ?? null,
					openrouter: profileOut(inf.remoteProfiles?.openrouter) ?? null
				},
				apiKeys: getApiKeys().map((k) => ({ id: k.id, name: k.name }))
			};
		}
		case 'models.probe': {
			const baseUrl = op.baseUrl?.trim();
			if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
				throw new Error('models.probe takes a baseUrl (http://…)');
			}
			if (op.apiKeyId && !getApiKeys().some((k) => k.id === op.apiKeyId)) {
				throw new Error(`no API key ${op.apiKeyId}: see models.list`);
			}
			const found = await probeInferenceServer(baseUrl, op.apiKeyId ?? null);
			return {
				baseUrl: found.base_url,
				kind: found.kind,
				engine: found.engine,
				contextSize: found.default_context_size,
				models: found.models.map((m) => ({
					id: m.id,
					name: m.display_name,
					contextSize: m.context_size,
					visionSupported: m.vision_supported,
					loaded: m.loaded
				}))
			};
		}
		default:
			throw new Error(`unknown operation ${(op as { type?: string }).type}`);
	}
}
