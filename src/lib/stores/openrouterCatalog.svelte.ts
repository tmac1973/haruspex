/**
 * The OpenRouter model catalog (`GET /api/v1/models`), cached apart from
 * settings.
 *
 * It is ~500 models and a few hundred KB, and it is a cache, not a setting:
 * inside `haruspex-settings` it was serialized on every settings save and
 * written into the shared `webview-store.json` with them. It lives under its
 * own `localStorage` key instead, deliberately WITHOUT the `haruspex` prefix,
 * so `persist.ts` neither mirrors it to the file nor clears it on load. Each
 * build (origin) keeps its own copy and refetches when it has none.
 */
import {
	fetchOpenRouterCatalog,
	OPENROUTER_CATALOG_TTL_MS,
	type OpenRouterModel
} from '#lib/openrouter.ts';

const STORAGE_KEY = 'openrouter-catalog-cache';

interface Cached {
	models: OpenRouterModel[];
	/** Epoch ms of the fetch. */
	at: number;
}

function read(): Cached | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<Cached>;
		if (!Array.isArray(parsed.models) || typeof parsed.at !== 'number') return null;
		return { models: parsed.models, at: parsed.at };
	} catch {
		return null;
	}
}

let cached = $state.raw<Cached | null>(null);
let loaded = false;
let inFlight: Promise<OpenRouterModel[]> | null = null;

function current(): Cached | null {
	if (!loaded) {
		cached = read();
		loaded = true;
	}
	return cached;
}

/** The cached catalog, or `null` when this build has never fetched one. */
export function getOpenRouterCatalog(): OpenRouterModel[] | null {
	return current()?.models ?? null;
}

/** Missing, or older than {@link OPENROUTER_CATALOG_TTL_MS}. */
export function isOpenRouterCatalogStale(now = Date.now()): boolean {
	const c = current();
	return !c || now - c.at > OPENROUTER_CATALOG_TTL_MS;
}

/** Replace the cache. `at` defaults to now. */
export function setOpenRouterCatalog(models: OpenRouterModel[], at = Date.now()): void {
	cached = { models, at };
	loaded = true;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
	} catch (e) {
		// Quota or a disabled store: the in-memory copy still serves this run.
		console.warn('OpenRouter catalog could not be cached:', e);
	}
}

/** Fetch the catalog and cache it. Concurrent callers share one request. */
export function refreshOpenRouterCatalog(): Promise<OpenRouterModel[]> {
	inFlight ??= fetchOpenRouterCatalog()
		.then((models) => {
			setOpenRouterCatalog(models);
			return models;
		})
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

/**
 * Refresh in the background when stale. The request path reads reasoning
 * caps off the catalog, so a build without one would otherwise send no
 * `reasoning` param until the user opened Settings.
 */
export function ensureOpenRouterCatalog(): void {
	if (!isOpenRouterCatalogStale()) return;
	void refreshOpenRouterCatalog().catch((e) => {
		console.warn('OpenRouter catalog refresh failed:', e);
	});
}

/** Tests only: drop the cache, saved copy included. */
export function __resetOpenRouterCatalogForTests(): void {
	localStorage.removeItem(STORAGE_KEY);
	cached = null;
	loaded = false;
	inFlight = null;
}
