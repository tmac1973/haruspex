/**
 * The specialists Settings → Code → Specialists keeps, and what each one
 * sends once its kind's defaults are filled in.
 */
import type { BackendOverride } from '#lib/api.ts';
import { uniqueName } from '#lib/generation/entry.ts';
import { specialistKind } from '#lib/specialists/kinds.ts';
import type { SpecialistEntry, SpecialistSampling } from '#lib/specialists/types.ts';
import { getSettings } from '#lib/stores/settings.ts';

/**
 * The entries whose kind is registered. One of an unknown kind (after a
 * downgrade, say) stays in Settings but is never offered.
 */
export function specialistEntries(): SpecialistEntry[] {
	return (getSettings().specialists ?? []).filter((e) => specialistKind(e.kind));
}

export function specialistById(id: string): SpecialistEntry | undefined {
	return specialistEntries().find((e) => e.id === id);
}

function kindOf(entry: SpecialistEntry) {
	const kind = specialistKind(entry.kind);
	if (!kind) throw new Error(`Unknown specialist kind '${entry.kind}'.`);
	return kind;
}

export function effectiveSampling(entry: SpecialistEntry): SpecialistSampling {
	return { ...kindOf(entry).defaultSampling, ...(entry.sampling ?? {}) };
}

/** `''` means no system message. */
export function effectiveSystemPrompt(entry: SpecialistEntry): string {
	return entry.systemPrompt ?? kindOf(entry).defaultSystemPrompt;
}

export function effectiveDescription(entry: SpecialistEntry): string {
	return entry.description ?? kindOf(entry).defaultDescription;
}

/** The URL as `api.ts` wants a base: no trailing slash, no `/v1`. */
export function specialistBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function entryBackend(entry: SpecialistEntry): BackendOverride {
	return {
		baseUrl: specialistBaseUrl(entry.url),
		apiKeyId: entry.keyId ?? undefined,
		modelId: entry.model
	};
}

/** A fresh entry of `kindId`, named after the kind and unique among `existing`. */
export function newSpecialistEntry(
	kindId: string,
	existing: readonly SpecialistEntry[] = getSettings().specialists ?? []
): SpecialistEntry {
	const kind = specialistKind(kindId);
	if (!kind) throw new Error(`Unknown specialist kind '${kindId}'.`);
	return {
		id: crypto.randomUUID(),
		name: uniqueName(
			kind.label,
			'',
			existing.map((e) => e.name)
		),
		kind: kindId,
		url: '',
		keyId: null,
		model: '',
		description: null,
		systemPrompt: null,
		sampling: null,
		onByDefault: false,
		acceptsImages: false
	};
}
