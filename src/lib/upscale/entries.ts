/**
 * The upscalers Settings → Image and Settings → Video generation keep
 * (`imageUpscalers`, `videoUpscalers`), in the order the upscale tools try
 * them: the list, and editing it. As `#lib/videogen/entries.ts` does for
 * video models.
 */

import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { hostOf } from '#lib/toolchest/client.ts';
import { uniqueName } from '#lib/generation/entry.ts';
import type { UpscalerCaps, UpscalerEntry, UpscalerKind } from '#lib/upscale/types.ts';
import type { VideoModelEntry } from '#lib/videogen/types.ts';

const FIELD = { image: 'imageUpscalers', video: 'videoUpscalers' } as const;

/** Where each list is set, for messages. */
export const UPSCALERS_SECTION: Record<UpscalerKind, string> = {
	image: 'Settings → Image → Upscalers',
	video: 'Settings → Video generation → Upscalers'
};

/** The upscalers of `kind`, in the order they are tried. */
export function upscalerEntries(kind: UpscalerKind): UpscalerEntry[] {
	const list = getSettings()[FIELD[kind]];
	return Array.isArray(list) ? list : [];
}

export function upscalerById(kind: UpscalerKind, id: string): UpscalerEntry | undefined {
	return upscalerEntries(kind).find((e) => e.id === id);
}

export function upscalerByName(kind: UpscalerKind, name: string): UpscalerEntry | undefined {
	const want = name.trim().toLowerCase();
	return upscalerEntries(kind).find((e) => e.name.toLowerCase() === want);
}

/** A new entry's name: its instance, or "Upscaler" before one is picked. */
export function defaultUpscalerName(e: Pick<UpscalerEntry, 'model'>): string {
	return e.model.trim() || 'Upscaler';
}

function save(kind: UpscalerKind, list: UpscalerEntry[]): void {
	updateSettings({ [FIELD[kind]]: list });
}

function freeName(kind: UpscalerKind, name: string, e: Pick<UpscalerEntry, 'id' | 'url'>): string {
	const taken = upscalerEntries(kind)
		.filter((o) => o.id !== e.id)
		.map((o) => o.name);
	return uniqueName(name, e.url.trim() ? hostOf(e.url) : '', taken);
}

/** A new upscaler at the end of the list, with `fill`; its id. */
export function addUpscaler(
	kind: UpscalerKind,
	fill: Partial<Pick<UpscalerEntry, 'url' | 'keyId' | 'model' | 'caps'>> = {}
): string {
	const id = crypto.randomUUID();
	const url = fill.url ?? '';
	const model = fill.model ?? '';
	const entry: UpscalerEntry = {
		id,
		name: freeName(kind, defaultUpscalerName({ model }), { id, url }),
		backend: 'llama-toolchest',
		url,
		keyId: fill.keyId ?? null,
		model,
		options: {},
		caps: fill.caps ? structuredClone(fill.caps) : null,
		capsAt: fill.caps ? Date.now() : null,
		renamed: false
	};
	save(kind, [...upscalerEntries(kind), entry]);
	return id;
}

/**
 * Change upscaler `id`. A new address, key or instance forgets what a probe
 * saw; a new instance renames it, unless the user named it.
 */
export function updateUpscaler(
	kind: UpscalerKind,
	id: string,
	patch: Partial<Omit<UpscalerEntry, 'id'>>
): void {
	save(
		kind,
		upscalerEntries(kind).map((e) => {
			if (e.id !== id) return e;
			const next = { ...e, ...patch };
			const config = next.url !== e.url || next.keyId !== e.keyId || next.model !== e.model;
			if (config && !('caps' in patch)) {
				next.caps = null;
				next.capsAt = null;
			}
			if (!next.renamed && next.model !== e.model) {
				next.name = freeName(kind, defaultUpscalerName(next), next);
			}
			return next;
		})
	);
}

/** Name upscaler `id`; an empty name gives it back its instance's. */
export function renameUpscaler(kind: UpscalerKind, id: string, name: string): void {
	const e = upscalerById(kind, id);
	if (!e) return;
	const own = name.trim();
	updateUpscaler(kind, id, {
		name: freeName(kind, own || defaultUpscalerName(e), e),
		renamed: own !== ''
	});
}

/** Move upscaler `id` up (-1) or down (+1) the list. */
export function moveUpscaler(kind: UpscalerKind, id: string, delta: -1 | 1): void {
	const list = [...upscalerEntries(kind)];
	const at = list.findIndex((e) => e.id === id);
	const to = at + delta;
	if (at < 0 || to < 0 || to >= list.length) return;
	[list[at], list[to]] = [list[to], list[at]];
	save(kind, list);
}

export function removeUpscaler(kind: UpscalerKind, id: string): void {
	save(
		kind,
		upscalerEntries(kind).filter((e) => e.id !== id)
	);
}

/** Remember what a probe of upscaler `id` said. Nothing is written when it is unchanged. */
export function saveUpscalerCaps(kind: UpscalerKind, id: string, caps: UpscalerCaps): void {
	const list = upscalerEntries(kind);
	const at = list.findIndex((e) => e.id === id);
	if (at < 0 || JSON.stringify(list[at].caps) === JSON.stringify(caps)) return;
	save(
		kind,
		list.map((e, i) => (i === at ? { ...e, caps: structuredClone(caps), capsAt: Date.now() } : e))
	);
}

/**
 * A video upscaler as a video model entry, so the toolchest video backend
 * (which sends and follows upscale jobs) can be built from it.
 */
export function upscalerAsVideoEntry(e: UpscalerEntry): VideoModelEntry {
	return {
		id: e.id,
		name: e.name,
		backend: 'llama-toolchest',
		url: e.url,
		keyId: e.keyId,
		model: e.model,
		options: {},
		caps: null,
		capsAt: null,
		renamed: e.renamed
	};
}
