/**
 * Finding a llama-toolchest the user already has. When the chat model comes
 * from a toolchest (Settings → Inference), its address and key are the
 * likely answer for Settings → Image and Settings → Music too: they prefill
 * when the user picks llama-toolchest there, and a one-line hint says when
 * that server has image or music models while the section is off. Nothing
 * turns itself on.
 */

import { getSettings } from '#lib/stores/settings.ts';
import { hostOf, toolchestJson } from '#lib/toolchest/client.ts';
import {
	parseGenerationModels,
	toolchestKeyFor,
	type GenerationKind
} from '#lib/toolchest/models.ts';

export interface FoundToolchest {
	baseUrl: string;
	apiKeyId: string | null;
}

/** The inference server, when it is a toolchest. */
export function inferenceToolchest(): FoundToolchest | null {
	const inf = getSettings().inferenceBackend;
	const baseUrl = inf.remoteBaseUrl.trim();
	if (inf.mode !== 'remote' || inf.remoteBackendKind !== 'llama-toolchest' || !baseUrl) {
		return null;
	}
	return { baseUrl, apiKeyId: inf.remoteApiKeyId };
}

/** The inference toolchest's host and how many `kind` models it has, or null for none. */
export async function toolchestHint(
	kind: GenerationKind
): Promise<{ host: string; count: number } | null> {
	try {
		const found = inferenceToolchest();
		if (!found) return null;
		const json = await toolchestJson(
			{ baseUrl: found.baseUrl, apiKey: await toolchestKeyFor(found.apiKeyId) },
			{ path: '/v1/models', timeoutMs: 6000 }
		);
		const count = parseGenerationModels(json, kind).length;
		return count > 0 ? { host: hostOf(found.baseUrl), count } : null;
	} catch {
		return null;
	}
}
