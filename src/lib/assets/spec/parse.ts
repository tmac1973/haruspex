/**
 * Reading a spec off disk.
 *
 * Tolerant in the same way the job configs are: a malformed file yields
 * errors rather than throwing, a missing optional field takes its default,
 * and top-level keys we do not recognise are kept so a user's own annotations
 * survive a job rewriting the file.
 */

import type { AssetEntry, AssetKind, AssetSpec, AssetStyle } from './types';
import { ASSET_KINDS } from './types';
import { DEFAULT_ANCHOR_IMAGE, DEFAULT_ANCHOR_RECIPE } from './paths';
import type { LoraRef } from '$lib/image/types';
import type { NormalizeProfile } from '$lib/ipc/gen/NormalizeProfile';

export type ParseResult = { spec: AssetSpec } | { errors: string[] };

const KNOWN_KEYS = new Set(['version', 'style', 'anchor', 'normalize', 'entries']);

function str(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

function optionalStr(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function kind(v: unknown): AssetKind {
	return ASSET_KINDS.includes(v as AssetKind) ? (v as AssetKind) : 'sprite';
}

function loras(v: unknown): LoraRef[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v
		.filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
		.map((l) => ({ name: str(l.name), strength: typeof l.strength === 'number' ? l.strength : 1 }))
		.filter((l) => l.name.length > 0);
	return out.length > 0 ? out : undefined;
}

function entry(raw: unknown): AssetEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const e = raw as Record<string, unknown>;
	const k = kind(e.kind);
	return {
		id: str(e.id),
		kind: k,
		prompt: str(e.prompt),
		out: str(e.out),
		...(typeof e.size === 'number' ? { size: e.size } : {}),
		// A texture is seamless unless it explicitly says otherwise; anything
		// else is not unless it does.
		...(typeof e.seamless === 'boolean'
			? { seamless: e.seamless }
			: k === 'texture'
				? { seamless: true }
				: {}),
		...(typeof e.seed === 'number' || e.seed === null ? { seed: e.seed as number | null } : {}),
		...(optionalStr(e.negativePrompt) ? { negativePrompt: str(e.negativePrompt) } : {}),
		...(optionalStr(e.notes) ? { notes: str(e.notes) } : {})
	};
}

function style(raw: unknown): AssetStyle {
	const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const l = loras(s.loras);
	return {
		prompt: str(s.prompt),
		...(optionalStr(s.negativePrompt) ? { negativePrompt: str(s.negativePrompt) } : {}),
		...(optionalStr(s.model) ? { model: str(s.model) } : {}),
		...(l ? { loras: l } : {})
	};
}

/**
 * Parse a spec. Returns errors only when the file is not a spec at all —
 * everything a spec CAN say but says wrongly is validation's job, because a
 * parser that refuses cannot report the second problem it would have found.
 */
export function parseAssetSpec(json: string): ParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch (e) {
		return { errors: [`The spec is not valid JSON — ${e instanceof Error ? e.message : e}`] };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { errors: ['The spec must be a JSON object.'] };
	}
	const o = raw as Record<string, unknown>;
	if (!Array.isArray(o.entries)) {
		return { errors: ['The spec has no "entries" array.'] };
	}
	if (!o.normalize || typeof o.normalize !== 'object') {
		return { errors: ['The spec has no "normalize" profile.'] };
	}

	const anchor = (o.anchor && typeof o.anchor === 'object' ? o.anchor : {}) as Record<
		string,
		unknown
	>;
	const unknown: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		if (!KNOWN_KEYS.has(k)) unknown[k] = v;
	}

	const spec: AssetSpec = {
		version: 1,
		style: style(o.style),
		anchor: {
			image: str(anchor.image, DEFAULT_ANCHOR_IMAGE),
			recipe: str(anchor.recipe, DEFAULT_ANCHOR_RECIPE)
		},
		normalize: o.normalize as NormalizeProfile,
		entries: o.entries.map(entry).filter((e): e is AssetEntry => e !== null),
		...(Object.keys(unknown).length > 0 ? { unknown } : {})
	};
	return { spec };
}
