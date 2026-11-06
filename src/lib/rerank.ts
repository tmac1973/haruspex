/**
 * Client for the `rerank_run` and `server_models_list` commands: rank
 * documents with any `/v1/rerank` server, and list a server's models with the
 * capabilities it reports so Settings can offer only rerank (or embedding)
 * models. Not tied to code search, so memory recall can use it too.
 */
import { invoke } from '@tauri-apps/api/core';
import { getApiKeyValue } from '#lib/stores/settings.ts';
import { apiKeysReady } from '#lib/stores/apiKeySecrets.ts';
import type { RerankResult } from '#lib/ipc/gen/RerankResult.ts';
import type { ServerModel } from '#lib/ipc/gen/ServerModel.ts';

export type { RerankResult, ServerModel };

/** A rerank server, in `SpecialistEntry`'s shape: URL, API key id, model. */
export interface RerankEndpoint {
	url: string;
	keyId: string | null;
	model: string;
}

async function resolveKey(keyId: string | null): Promise<string | null> {
	await apiKeysReady();
	return getApiKeyValue(keyId) || null;
}

/** Rank `documents` against `query`, highest score first. Rejects on a
 *  timeout (15 s by default, held to 1–60 s), an HTTP error or a body it
 *  can't read. */
export async function rerankDocuments(
	endpoint: RerankEndpoint,
	query: string,
	documents: string[],
	timeoutMs?: number
): Promise<RerankResult> {
	return invoke<RerankResult>('rerank_run', {
		baseUrl: endpoint.url,
		apiKey: await resolveKey(endpoint.keyId),
		model: endpoint.model,
		query,
		documents,
		timeoutMs: timeoutMs ?? null
	});
}

/** The models a server lists at `GET /v1/models`, sorted by id. */
export async function listServerModels(url: string, keyId: string | null): Promise<ServerModel[]> {
	return invoke<ServerModel[]>('server_models_list', {
		baseUrl: url,
		apiKey: await resolveKey(keyId)
	});
}
