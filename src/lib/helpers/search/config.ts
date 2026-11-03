/** The Search helper's settings (Settings → Code → Helpers → Search). */
import type { RerankEndpoint } from '#lib/rerank.ts';

export interface SearchConfig {
	/** The server that reranks keyword candidates; null ranks by keywords alone. */
	rerank: RerankEndpoint | null;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Whatever is stored, as a `SearchConfig`: a reranker needs a URL and a model. */
export function parseSearchConfig(raw: unknown): SearchConfig {
	const r = (raw as { rerank?: Record<string, unknown> } | null)?.rerank;
	if (!r || typeof r !== 'object' || !nonEmpty(r.url) || !nonEmpty(r.model)) {
		return { rerank: null };
	}
	return {
		rerank: { url: r.url, model: r.model, keyId: typeof r.keyId === 'string' ? r.keyId : null }
	};
}
