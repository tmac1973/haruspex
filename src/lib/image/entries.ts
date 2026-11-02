/**
 * The image models Settings → Image keeps (`imageModels`), each one model on
 * one server, in the order the image tools try them: the list, and editing
 * it; the one a job was sent for; the key a call to one sends. A backend is
 * built from an entry (`#lib/image/registry.ts`).
 */

import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import type { ImageBackendCapabilities, ImageModelEntry } from '#lib/image/types.ts';
import type { ImageJobHandle } from '#lib/image/backend.ts';
import { toolchestKeyFor } from '#lib/toolchest/models.ts';
import { hostOf } from '#lib/toolchest/client.ts';
import { uniqueName } from '#lib/generation/entry.ts';
import { imageKeysReady } from '#lib/image/keys.ts';
import {
	LEGACY_ENTRY_ID,
	defaultImageName,
	entryFromFields,
	imageModelsFromFields
} from '#lib/image/fields.ts';

export { IMAGE_BACKEND_LABEL, LEGACY_ENTRY_ID, defaultImageName } from '#lib/image/fields.ts';

type EntryKind = ImageModelEntry['backend'];

/**
 * The image models, in the order they are tried. Settings from before the
 * list (as some tests still hand in) are read through their old fields.
 */
export function imageEntries(): ImageModelEntry[] {
	const s = getSettings();
	return Array.isArray(s.imageModels) ? s.imageModels : imageModelsFromFields(s);
}

/** The first image model, or null when there is none. */
export function firstImageEntry(): ImageModelEntry | null {
	return imageEntries()[0] ?? null;
}

/** The image models' names, in order: what the tools' `model` may be. */
export function entryNames(): string[] {
	return imageEntries().map((e) => e.name);
}

/** The pictures one edit took before models said: what an unprobed one is assumed to take. */
export const UNPROBED_EDIT_PICTURES = 4;

/**
 * The most pictures one edit can combine on any image model; 0 when none can
 * edit. A model no probe has answered for counts as taking
 * `UNPROBED_EDIT_PICTURES`, so a list nobody has probed still offers editing.
 */
export function maxEditPictures(): number {
	const each = imageEntries().map((e) =>
		!e.caps ? UNPROBED_EDIT_PICTURES : e.caps.edit ? (e.caps.maxEditImages ?? 1) : 0
	);
	return Math.max(0, ...each);
}

/** Some image model can `op`, or may: one no probe has answered for counts. */
export function anyEntryCan(op: 'edit' | 'upscale'): boolean {
	return imageEntries().some((e) => !e.caps || !!e.caps[op]);
}

/** The image model with this id, or undefined. */
export function entryById(id: string): ImageModelEntry | undefined {
	return imageEntries().find((e) => e.id === id);
}

/**
 * The entry `kind`'s old single-backend fields describe: for a job handle
 * from before the list, and the one-backend-per-kind exports tests use.
 */
export function legacyEntryFor(kind: EntryKind): ImageModelEntry {
	return entryFromFields(getSettings(), kind);
}

function save(list: ImageModelEntry[]): void {
	updateSettings({ imageModels: list });
}

/** `e`'s server's host, for telling two entries with one name apart. */
function hostOfEntry(e: Pick<ImageModelEntry, 'url'>): string {
	return e.url.trim() ? hostOf(e.url) : '';
}

/** `name`, made different from every other entry's. */
function freeName(name: string, e: Pick<ImageModelEntry, 'id' | 'url'>): string {
	const taken = imageEntries()
		.filter((o) => o.id !== e.id)
		.map((o) => o.name);
	return uniqueName(name, hostOfEntry(e), taken);
}

/** A new entry for `backend` at the end of the list, with `fill`; its id. */
export function addImageModel(
	backend: EntryKind,
	fill: Partial<Pick<ImageModelEntry, 'url' | 'keyId'>> = {}
): string {
	const id = crypto.randomUUID();
	const draft = { id, url: fill.url ?? '' };
	const entry: ImageModelEntry = {
		id,
		name: freeName(defaultImageName({ backend, model: '' }), draft),
		backend,
		url: fill.url ?? '',
		keyId: fill.keyId ?? null,
		model: '',
		options: {},
		caps: null,
		capsAt: null,
		renamed: false
	};
	save([...imageEntries(), entry]);
	return id;
}

/**
 * Change entry `id`. A change to its backend, address, key, model or options
 * forgets what a probe saw; a new model or backend renames it, unless the
 * user named it.
 */
export function updateImageModel(id: string, patch: Partial<Omit<ImageModelEntry, 'id'>>): void {
	save(
		imageEntries().map((e) => {
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
				next.name = freeName(defaultImageName(next), next);
			}
			return next;
		})
	);
}

/** Name entry `id`; an empty name gives it back its model's. */
export function renameImageModel(id: string, name: string): void {
	const e = entryById(id);
	if (!e) return;
	const own = name.trim();
	updateImageModel(id, {
		name: freeName(own || defaultImageName(e), e),
		renamed: own !== ''
	});
}

/** Move entry `id` up (-1) or down (+1) the list. */
export function moveImageModel(id: string, delta: -1 | 1): void {
	const list = [...imageEntries()];
	const at = list.findIndex((e) => e.id === id);
	const to = at + delta;
	if (at < 0 || to < 0 || to >= list.length) return;
	[list[at], list[to]] = [list[to], list[at]];
	save(list);
}

export function removeImageModel(id: string): void {
	save(imageEntries().filter((e) => e.id !== id));
}

/**
 * Remember what a probe of entry `id` said it can do, so the tools and the
 * prompt can say so without asking every server first. Nothing is written
 * when it is what was already kept.
 */
export function saveImageCaps(id: string, caps: ImageBackendCapabilities): void {
	const list = getSettings().imageModels;
	if (!Array.isArray(list)) return;
	const at = list.findIndex((e) => e.id === id);
	if (at < 0 || JSON.stringify(list[at].caps) === JSON.stringify(caps)) return;
	const next = list.map((e, i) =>
		i === at ? { ...e, caps: structuredClone(caps), capsAt: Date.now() } : e
	);
	save(next);
}

/**
 * The key a call for `e` sends: its named key's value, or none. A ComfyUI or
 * Lemonade entry waits for its old key to become a named one first.
 */
export async function entryApiKey(e: ImageModelEntry): Promise<string> {
	if (!e.keyId && (e.backend === 'comfyui' || e.backend === 'lemonade')) {
		await imageKeysReady();
		// A backend built before the migration holds the entry as it was.
		e = entryById(e.id) ?? e;
	}
	return e.keyId ? toolchestKeyFor(e.keyId) : '';
}

/**
 * The entry a job `handle` was sent for, for `resume`: the saved one with its
 * id; for a handle from before the list, the one the old fields for its
 * backend describe; else one made from the handle alone. Either way `resume`
 * asks the server and key the handle names.
 */
export function entryForHandle(handle: ImageJobHandle): ImageModelEntry | null {
	if (handle.backend === 'none') return null;
	const saved = imageEntries().find((e) => e.id === handle.entryId && e.backend === handle.backend);
	if (saved) return saved;
	if (!handle.entryId || handle.entryId === LEGACY_ENTRY_ID) {
		return legacyEntryFor(handle.backend);
	}
	return {
		id: handle.entryId,
		name: defaultImageName({ backend: handle.backend, model: handle.model }),
		backend: handle.backend,
		url: handle.baseUrl,
		keyId: handle.extra?.keyId ?? null,
		model: handle.model,
		options: {},
		caps: null,
		capsAt: null,
		renamed: false
	};
}
