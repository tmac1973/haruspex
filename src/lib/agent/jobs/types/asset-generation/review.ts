/**
 * Replacing assets a run accepted and a person did not.
 *
 * A run's checks and judge pass things a person rejects at a glance — a player
 * sprite with a coin stuck to it. The fix is the mechanism re-runs already
 * have: an asset whose file is missing is generated again, a small sheet is
 * padded with finished members of its group so it matches them (`padding`),
 * and nothing else is touched. Review only has to make the chosen files
 * missing — without destroying them — and carry the person's note into the
 * prompt, so the next attempt is not the same roll of the dice.
 *
 * The old file is moved into a `.history` folder beside it, never deleted:
 * a regeneration can come out worse, and the one before must be recoverable.
 */

import type { AssetEntry, AssetSpec } from '$lib/assets/spec/types';

/** One asset the person wants made again. */
export interface ReviewMark {
	id: string;
	/** Appended to the asset's prompt, e.g. "no coin, hands empty". Optional. */
	note?: string;
}

/** Where a replaced file goes: beside it, in `.history`, stamped. */
export function historyPath(out: string, stamp: string): string {
	const slash = out.lastIndexOf('/');
	const dir = slash >= 0 ? out.slice(0, slash + 1) : '';
	const file = out.slice(slash + 1);
	const dot = file.lastIndexOf('.');
	const [base, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
	return `${dir}.history/${base}-${stamp}${ext}`;
}

/** A filesystem-safe timestamp, e.g. `20261002-203011`. */
export function stamp(date: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		`${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
		`${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
	);
}

/**
 * The prompt with a note added. The note is kept in the spec, not used once:
 * a later re-run of the same asset should not bring the coin back.
 */
export function amendPrompt(prompt: string, note: string | undefined): string {
	const n = (note ?? '').trim().replace(/[.\s]+$/, '');
	if (!n) return prompt;
	const base = prompt.trim().replace(/[.\s]+$/, '');
	return `${base}, ${n}`;
}

/** The spec with each marked asset's note folded into its prompt. */
export function applyNotes(spec: AssetSpec, marks: ReviewMark[]): AssetSpec {
	const notes = new Map(marks.map((m) => [m.id, m.note]));
	return {
		...spec,
		entries: spec.entries.map(
			(e): AssetEntry =>
				notes.has(e.id) ? { ...e, prompt: amendPrompt(e.prompt, notes.get(e.id)) } : e
		)
	};
}

export interface ReviewDeps {
	exists: (rel: string) => Promise<boolean>;
	move: (fromRel: string, toRel: string) => Promise<void>;
	writeSpec: (spec: AssetSpec) => Promise<void>;
	/** Starts the asset job; it regenerates whatever is missing. */
	run: () => Promise<number | null>;
	now?: () => Date;
}

export interface ReviewResult {
	/** Files moved aside, from → to. */
	moved: Array<{ from: string; to: string }>;
	/** Ids whose prompt gained a note. */
	amended: string[];
	runId: number | null;
}

/**
 * Make the marked assets missing (moved to `.history`), save their notes into
 * the spec, and start the asset job. The spec is written before anything is
 * moved, so a failure part-way leaves the files where they were.
 */
export async function regenerateMarked(
	spec: AssetSpec,
	marks: ReviewMark[],
	deps: ReviewDeps
): Promise<ReviewResult> {
	const byId = new Map(spec.entries.map((e) => [e.id, e]));
	const chosen = marks.filter((m) => byId.has(m.id));
	const amended = chosen.filter((m) => (m.note ?? '').trim()).map((m) => m.id);
	if (amended.length > 0) await deps.writeSpec(applyNotes(spec, chosen));

	const when = stamp((deps.now ?? (() => new Date()))());
	const moved: ReviewResult['moved'] = [];
	for (const m of chosen) {
		const out = byId.get(m.id)!.out;
		if (!(await deps.exists(out))) continue;
		const to = historyPath(out, when);
		await deps.move(out, to);
		moved.push({ from: out, to });
	}
	return { moved, amended, runId: await deps.run() };
}

/**
 * The spec after a run: an entry whose best rejected attempt was kept is
 * marked `rejected` with why, and one generated and accepted is unmarked.
 * Entries the run skipped or could not make keep whatever they had. Returns
 * null when nothing changed, so the file is not rewritten for nothing.
 */
export function markRejections(
	spec: AssetSpec,
	outcomes: Array<{ id: string; status: string; kept?: boolean; reason?: string }>
): AssetSpec | null {
	const byId = new Map(outcomes.map((o) => [o.id, o]));
	let changed = false;
	const entries = spec.entries.map((e): AssetEntry => {
		const o = byId.get(e.id);
		if (o?.kept) {
			const rejected = (o.reason ?? 'rejected by the checks').trim();
			if (e.rejected === rejected) return e;
			changed = true;
			return { ...e, rejected };
		}
		if (o?.status === 'done' && e.rejected !== undefined) {
			changed = true;
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { rejected, ...rest } = e;
			return rest;
		}
		return e;
	});
	return changed ? { ...spec, entries } : null;
}
