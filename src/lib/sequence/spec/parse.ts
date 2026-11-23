/**
 * Reading a sequence spec from JSON: strict about shape, so a mistake the
 * model made comes back to it as a problem naming the place, never dropped
 * quietly. Unknown keys are problems too. Missing optional fields get their
 * defaults: `reanchor_every` 6, hard cuts between sections, no music or
 * narration, no clip sound.
 */
import type { Fit } from '#lib/ipc/gen/Fit.ts';
import {
	DEFAULT_REANCHOR,
	SPEC_VERSION,
	type ExistingSection,
	type GeneratedSection,
	type Join,
	type MusicBed,
	type Narration,
	type Section,
	type SequenceSpec,
	type Sound
} from '#lib/sequence/spec/types.ts';

export interface Parsed {
	/** Null when the JSON can't be read as a spec at all. */
	spec: SequenceSpec | null;
	/** Each mistake, naming where it is ("sections[1].seconds: …"). */
	problems: string[];
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** A reader for one object: its fields by type, noting what is wrong. */
class Fields {
	constructor(
		private readonly o: Json,
		private readonly at: string,
		private readonly problems: string[],
		allowed: string[]
	) {
		for (const k of Object.keys(o)) {
			if (!allowed.includes(k)) problems.push(`${this.where(k)}: unknown key`);
		}
	}

	where(k: string): string {
		return this.at ? `${this.at}.${k}` : k;
	}

	wrong(k: string, what: string): void {
		this.problems.push(`${this.where(k)}: ${what}`);
	}

	str(k: string, required: true): string;
	str(k: string, required?: false): string | undefined;
	str(k: string, required = false): string | undefined {
		const v = this.o[k];
		if (v === undefined || v === null) {
			if (required) this.wrong(k, 'missing');
			return required ? '' : undefined;
		}
		if (typeof v !== 'string' || (required && !v.trim())) {
			this.wrong(k, required ? 'must be a non-empty string' : 'must be a string');
			return required ? '' : undefined;
		}
		return v.trim();
	}

	num(k: string, required: true): number;
	num(k: string, required?: false): number | undefined;
	num(k: string, required = false): number | undefined {
		const v = this.o[k];
		if (v === undefined || v === null) {
			if (required) this.wrong(k, 'missing');
			return required ? 0 : undefined;
		}
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			this.wrong(k, 'must be a number');
			return required ? 0 : undefined;
		}
		return v;
	}

	bool(k: string): boolean | undefined {
		const v = this.o[k];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== 'boolean') {
			this.wrong(k, 'must be true or false');
			return undefined;
		}
		return v;
	}

	list(k: string): unknown[] | undefined {
		const v = this.o[k];
		if (v === undefined || v === null) return undefined;
		if (!Array.isArray(v)) {
			this.wrong(k, 'must be a list');
			return undefined;
		}
		return v;
	}
}

function fitOf(v: unknown, at: string, problems: string[]): Fit | undefined {
	if (v === undefined || v === null) return undefined;
	if (v === 'letterbox' || v === 'fill') return { mode: v };
	if (isObj(v)) {
		const f = new Fields(v, at, problems, ['x', 'y', 'w', 'h']);
		const [x, y, w, h] = ['x', 'y', 'w', 'h'].map((k) => f.num(k, true));
		return { mode: 'crop', x, y, w, h };
	}
	problems.push(`${at}: must be "letterbox", "fill" or a crop region {x, y, w, h}`);
	return undefined;
}

function sectionOf(v: unknown, at: string, problems: string[]): Section | null {
	if (!isObj(v)) {
		problems.push(`${at}: must be an object`);
		return null;
	}
	if (v.kind === 'existing') {
		const f = new Fields(v, at, problems, ['kind', 'id', 'path', 'in_secs', 'out_secs', 'fit']);
		const s: ExistingSection = {
			kind: 'existing',
			id: f.str('id', true),
			path: f.str('path', true)
		};
		const inSecs = f.num('in_secs');
		const outSecs = f.num('out_secs');
		const fit = fitOf(v.fit, f.where('fit'), problems);
		if (inSecs !== undefined) s.in_secs = inSecs;
		if (outSecs !== undefined) s.out_secs = outSecs;
		if (fit) s.fit = fit;
		return s;
	}
	if (v.kind !== 'generated') {
		problems.push(`${at}.kind: must be "generated" or "existing"`);
		return null;
	}
	const f = new Fields(v, at, problems, [
		'kind',
		'id',
		'prompt',
		'seconds',
		'start_image',
		'keyframe_prompt',
		'negative_prompt',
		'seed'
	]);
	const s: GeneratedSection = {
		kind: 'generated',
		id: f.str('id', true),
		prompt: f.str('prompt', true),
		seconds: f.num('seconds', true)
	};
	for (const k of ['start_image', 'keyframe_prompt', 'negative_prompt'] as const) {
		const t = f.str(k);
		if (t) s[k] = t;
	}
	const seed = f.num('seed');
	if (seed !== undefined) s.seed = seed;
	return s;
}

function joinOf(v: unknown, at: string, problems: string[]): Join {
	if (!isObj(v)) {
		problems.push(`${at}: must be an object`);
		return { kind: 'cut' };
	}
	const f = new Fields(v, at, problems, ['kind', 'secs', 'prompt']);
	const kind = v.kind;
	if (kind !== 'cut' && kind !== 'crossfade' && kind !== 'transition') {
		problems.push(`${at}.kind: must be "cut", "crossfade" or "transition"`);
		return { kind: 'cut' };
	}
	const j: Join = { kind };
	const secs = f.num('secs');
	const prompt = f.str('prompt');
	if (secs !== undefined) j.secs = secs;
	if (prompt) j.prompt = prompt;
	return j;
}

function musicOf(v: unknown, at: string, problems: string[]): MusicBed | null {
	if (!isObj(v)) {
		problems.push(`${at}: must be an object`);
		return null;
	}
	const f = new Fields(v, at, problems, ['id', 'sections', 'caption', 'lufs']);
	const sections = (f.list('sections') ?? []).filter((s, i) => {
		if (typeof s === 'string') return true;
		problems.push(`${at}.sections[${i}]: must be a section id`);
		return false;
	}) as string[];
	if (sections.length === 0) f.wrong('sections', 'names no section');
	const bed: MusicBed = { id: f.str('id', true), sections, caption: f.str('caption', true) };
	const lufs = f.num('lufs');
	if (lufs !== undefined) bed.lufs = lufs;
	return bed;
}

function narrationOf(v: unknown, at: string, problems: string[]): Narration | null {
	if (!isObj(v)) {
		problems.push(`${at}: must be an object`);
		return null;
	}
	const f = new Fields(v, at, problems, ['section', 'at_secs', 'text', 'voice']);
	const n: Narration = {
		section: f.str('section', true),
		at_secs: f.num('at_secs', true),
		text: f.str('text', true)
	};
	const voice = f.str('voice');
	if (voice) n.voice = voice;
	return n;
}

function listOf<T>(
	raw: unknown[] | undefined,
	at: string,
	problems: string[],
	one: (v: unknown, at: string, problems: string[]) => T | null
): T[] {
	return (raw ?? []).flatMap((v, i) => {
		const got = one(v, `${at}[${i}]`, problems);
		return got === null ? [] : [got];
	});
}

function soundOf(v: unknown, problems: string[]): Sound {
	if (v === undefined || v === null) return { clip_sound: false, music: [], narration: [] };
	if (!isObj(v)) {
		problems.push('sound: must be an object');
		return { clip_sound: false, music: [], narration: [] };
	}
	const f = new Fields(v, 'sound', problems, ['clip_sound', 'music', 'narration']);
	return {
		clip_sound: f.bool('clip_sound') ?? false,
		music: listOf(f.list('music'), 'sound.music', problems, musicOf),
		narration: listOf(f.list('narration'), 'sound.narration', problems, narrationOf)
	};
}

/** A spec from its JSON text or an already-parsed value. */
export function parseSequenceSpec(json: unknown): Parsed {
	const problems: string[] = [];
	let v = json;
	if (typeof json === 'string') {
		try {
			v = JSON.parse(json);
		} catch (e) {
			return { spec: null, problems: [`not JSON: ${(e as Error).message}`] };
		}
	}
	if (!isObj(v)) return { spec: null, problems: ['the spec must be a JSON object'] };
	const f = new Fields(v, '', problems, [
		'version',
		'title',
		'style',
		'preset',
		'sections',
		'joins',
		'sound',
		'reanchor_every'
	]);
	const version = f.num('version') ?? SPEC_VERSION;
	if (version !== SPEC_VERSION) f.wrong('version', `must be ${SPEC_VERSION}`);
	const sections = listOf(f.list('sections'), 'sections', problems, sectionOf);
	if (sections.length === 0) problems.push('sections: the spec needs at least one section');
	const rawJoins = f.list('joins');
	const joins = rawJoins
		? rawJoins.map((j, i) => joinOf(j, `joins[${i}]`, problems))
		: sections.slice(1).map((): Join => ({ kind: 'cut' }));
	if (rawJoins && sections.length > 0 && joins.length !== sections.length - 1) {
		problems.push(
			`joins: ${sections.length} sections need ${sections.length - 1} joins, one between each two; there are ${joins.length}`
		);
	}
	const spec: SequenceSpec = {
		version: SPEC_VERSION,
		title: f.str('title', true),
		style: f.str('style') ?? '',
		sections,
		joins,
		sound: soundOf(v.sound, problems),
		reanchor_every: f.num('reanchor_every') ?? DEFAULT_REANCHOR
	};
	const preset = f.str('preset');
	if (preset) spec.preset = preset;
	return { spec, problems };
}
