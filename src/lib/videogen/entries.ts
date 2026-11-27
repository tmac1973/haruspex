/**
 * The video models Settings → Video generation keeps (`videoModels`), each one
 * model on one server, in the order `generate_video` tries them: the list, and
 * editing it; the one a job was sent for; the key a call to one sends. A
 * backend is built from an entry (`#lib/videogen/registry.ts`).
 */

import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { toolchestKeyFor } from '#lib/toolchest/models.ts';
import { hostOf } from '#lib/toolchest/client.ts';
import { enabledEntries, uniqueName, withEnabled } from '#lib/generation/entry.ts';
import { defaultVideoName } from '#lib/videogen/fields.ts';
import type {
	VideoBackendKind,
	VideoCaps,
	VideoJobHandle,
	VideoModelEntry
} from '#lib/videogen/types.ts';

export { VIDEO_BACKEND_LABEL, defaultVideoName } from '#lib/videogen/fields.ts';

/** Every video model Settings keeps, turned off or not: for Settings and editing the list. */
export function allVideoEntries(): VideoModelEntry[] {
	const list = getSettings().videoModels;
	return Array.isArray(list) ? list : [];
}

/** The video models that are turned on, in the order they are tried. */
export function videoEntries(): VideoModelEntry[] {
	return enabledEntries(allVideoEntries());
}

/** The first video model, or null when there is none. */
export function firstVideoEntry(): VideoModelEntry | null {
	return videoEntries()[0] ?? null;
}

/** The video models' names, in order: what the tool's `model` may be. */
export function videoEntryNames(): string[] {
	return videoEntries().map((e) => e.name);
}

/** The video model with this id, turned off or not, or undefined. */
export function videoEntryById(id: string): VideoModelEntry | undefined {
	return allVideoEntries().find((e) => e.id === id);
}

/** The video model with this name, or undefined. */
export function videoEntryByName(name: string): VideoModelEntry | undefined {
	const want = name.trim().toLowerCase();
	return videoEntries().find((e) => e.name.toLowerCase() === want);
}

function blankEntry(kind: VideoBackendKind, fill: Partial<VideoModelEntry> = {}): VideoModelEntry {
	const model = fill.model ?? '';
	return {
		id: fill.id ?? kind,
		name: fill.name ?? defaultVideoName({ backend: kind, model }),
		backend: kind,
		url: fill.url ?? '',
		keyId: fill.keyId ?? null,
		model,
		options: fill.options ?? {},
		caps: fill.caps ?? null,
		capsAt: fill.capsAt ?? null,
		renamed: fill.renamed ?? false
	};
}

function save(list: VideoModelEntry[]): void {
	updateSettings({ videoModels: list });
}

/** `name`, made different from every other entry's. */
function freeName(name: string, e: Pick<VideoModelEntry, 'id' | 'url'>): string {
	const taken = allVideoEntries()
		.filter((o) => o.id !== e.id)
		.map((o) => o.name);
	return uniqueName(name, e.url.trim() ? hostOf(e.url) : '', taken);
}

/** A new entry for `backend` at the end of the list, with `fill`; its id. */
export function addVideoModel(
	backend: VideoBackendKind,
	fill: Partial<Pick<VideoModelEntry, 'url' | 'keyId'>> = {}
): string {
	const id = crypto.randomUUID();
	const entry = blankEntry(backend, {
		id,
		name: freeName(defaultVideoName({ backend, model: '' }), { id, url: fill.url ?? '' }),
		url: fill.url ?? '',
		keyId: fill.keyId ?? null
	});
	save([...allVideoEntries(), entry]);
	return id;
}

/**
 * Change entry `id`. A change to its backend, address, key, model or options
 * forgets what a probe saw; a new model or backend renames it, unless the
 * user named it.
 */
export function updateVideoModel(id: string, patch: Partial<Omit<VideoModelEntry, 'id'>>): void {
	save(
		allVideoEntries().map((e) => {
			if (e.id !== id) return e;
			const next = { ...e, ...patch };
			const config =
				next.backend !== e.backend ||
				next.url !== e.url ||
				next.keyId !== e.keyId ||
				next.model !== e.model ||
				JSON.stringify(next.options) !== JSON.stringify(e.options);
			if (config && !('caps' in patch)) {
				next.caps = null;
				next.capsAt = null;
			}
			if (!next.renamed && (next.model !== e.model || next.backend !== e.backend)) {
				next.name = freeName(defaultVideoName(next), next);
			}
			return next;
		})
	);
}

/** Name entry `id`; an empty name gives it back its model's. */
export function renameVideoModel(id: string, name: string): void {
	const e = videoEntryById(id);
	if (!e) return;
	const own = name.trim();
	updateVideoModel(id, {
		name: freeName(own || defaultVideoName(e), e),
		renamed: own !== ''
	});
}

/** Move entry `id` up (-1) or down (+1) the list. */
export function moveVideoModel(id: string, delta: -1 | 1): void {
	const list = [...allVideoEntries()];
	const at = list.findIndex((e) => e.id === id);
	const to = at + delta;
	if (at < 0 || to < 0 || to >= list.length) return;
	[list[at], list[to]] = [list[to], list[at]];
	save(list);
}

export function removeVideoModel(id: string): void {
	save(allVideoEntries().filter((e) => e.id !== id));
}

/** Turn entry `id` on or off, keeping it and its place in the list. */
export function setVideoModelEnabled(id: string, on: boolean): void {
	save(allVideoEntries().map((e) => (e.id === id ? withEnabled(e, on) : e)));
}

/**
 * Remember what a probe of entry `id` said it can do. Nothing is written when
 * it is what was already kept.
 */
export function saveVideoCaps(id: string, caps: VideoCaps): void {
	const list = allVideoEntries();
	const at = list.findIndex((e) => e.id === id);
	if (at < 0 || JSON.stringify(list[at].caps) === JSON.stringify(caps)) return;
	save(
		list.map((e, i) => (i === at ? { ...e, caps: structuredClone(caps), capsAt: Date.now() } : e))
	);
}

/** The key a call for `e` sends: its named key's value, or none. */
export function videoEntryApiKey(e: Pick<VideoModelEntry, 'keyId'>): Promise<string> {
	return toolchestKeyFor(e.keyId);
}

/**
 * The entry a job `handle` was sent for, for `resume`: the saved one with its
 * id and backend, else one made from the handle alone (a model since removed
 * or changed, or a handle from before the list, which names none). Either way
 * `resume` asks the server, backend and key the handle names.
 */
export function videoEntryForHandle(handle: VideoJobHandle): VideoModelEntry {
	const saved = allVideoEntries().find(
		(e) => e.id === handle.entryId && e.backend === handle.backend
	);
	if (saved) return saved;
	return blankEntry(handle.backend, {
		id: handle.entryId || handle.backend,
		url: handle.baseUrl,
		keyId: handle.keyId || null,
		model: handle.model,
		options: { ...(handle.extra ?? {}) }
	});
}
