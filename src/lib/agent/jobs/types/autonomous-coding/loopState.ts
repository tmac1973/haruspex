/**
 * Pure state for the autonomous-coding loop: the task list, attempt counts,
 * done/blocked transitions, and the TODO-coding.md markdown round-trip.
 *
 * The markdown file is the loop's ground truth — every fresh-context
 * iteration re-reads it, and a re-run of the job resumes from it (no DB
 * resume plumbing; the plan dir on disk carries the state). That's why this
 * module both renders AND parses the format: render(parse(x)) must be
 * lossless for status, attempts, titles, and descriptions.
 *
 * No side effects here — the pipeline owns all I/O. This is where the unit
 * tests live.
 */

import { VERIFICATION_COMMAND_HEADING } from './planParse';

export type TaskStatus = 'todo' | 'done' | 'blocked';

export interface TaskItem {
	/** Runner-assigned two-digit position id ("01", "02", …) — never the model's. */
	id: string;
	title: string;
	/** What "done" means for this item (may be multi-line). */
	description: string;
	status: TaskStatus;
	/** Failed attempts so far (a blocked item sits at the max). */
	attempts: number;
	/** Id of the phase this item belongs to; undefined on a phaseless legacy list. */
	phase?: string;
	/** True for a runner-injected repair item (single attempt, fixes a phase). */
	repair?: boolean;
}

export type PhaseVerifyStatus = 'pending' | 'passed' | 'blocked';

/**
 * A verification boundary. Deep verification runs once per phase — when its
 * last item lands — instead of once per item, because per-item verification
 * cost is multiplied by the item count (an observed run maintained a 271-line
 * validator against a 93-line program, re-running it every step).
 */
export interface PhaseInfo {
	/** Runner-assigned two-digit id ("01", "02", …), in plan order. */
	id: string;
	title: string;
	verify: PhaseVerifyStatus;
	/** Repair cycles consumed (repair item + re-verification = one cycle). */
	repairs: number;
}

/**
 * The loop's whole persisted state: phases plus the flat, ordered item list.
 * `phases` empty ⇒ a legacy phaseless checklist; everything falls back to the
 * old per-item behaviour and the markdown round-trip emits the old format.
 */
export interface LoopPlan {
	phases: PhaseInfo[];
	items: TaskItem[];
}

/**
 * Repair cycles allowed per phase before it is marked blocked. Each cycle is
 * one injected repair item (single attempt — the CYCLE is the retry mechanism)
 * followed by a fresh verification run. Verification re-runs after every
 * repair regardless of what the repair reported, since a "failed" repair may
 * still have fixed part of the problem.
 */
export const MAX_PHASE_REPAIR_CYCLES = 5;

/**
 * Normalize a submit_task_list payload into a full plan, grouping items into
 * phases by their `phase` title (first-appearance order).
 *
 * Every plan ends up with at least one phase: items the model left unphased
 * are gathered into a catch-all, because a phaseless item would never sit
 * inside a verification boundary and deep verification would simply never run
 * for it.
 */
export function normalizeTaskListPlan(raw: unknown): LoopPlan {
	if (!Array.isArray(raw)) return { phases: [], items: [] };
	const phases: PhaseInfo[] = [];
	const phaseIdByTitle = new Map<string, string>();
	const items: TaskItem[] = [];
	const phaseFor = (title: string): string => {
		const key = title.replace(/\s+/g, ' ').trim();
		const existing = phaseIdByTitle.get(key.toLowerCase());
		if (existing) return existing;
		const id = String(phases.length + 1).padStart(2, '0');
		phases.push({ id, title: key, verify: 'pending', repairs: 0 });
		phaseIdByTitle.set(key.toLowerCase(), id);
		return id;
	};
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') continue;
		const e = entry as Record<string, unknown>;
		const title = typeof e.title === 'string' ? e.title.replace(/\s+/g, ' ').trim() : '';
		if (!title) continue;
		const description = typeof e.description === 'string' ? e.description.trim() : '';
		const phaseTitle = typeof e.phase === 'string' && e.phase.trim() ? e.phase : 'Whole plan';
		items.push({
			id: String(items.length + 1).padStart(2, '0'),
			title,
			description,
			status: 'todo',
			attempts: 0,
			phase: phaseFor(phaseTitle)
		});
	}
	return { phases, items };
}

/**
 * Give a phaseless plan (a legacy resume, or a normalize edge case) a single
 * catch-all phase so deep verification runs at least once, at the end.
 */
export function ensurePhased(plan: LoopPlan): LoopPlan {
	if (plan.phases.length > 0 || plan.items.length === 0) return plan;
	const id = '01';
	return {
		phases: [{ id, title: 'Whole plan', verify: 'pending', repairs: 0 }],
		items: plan.items.map((i) => ({ ...i, phase: id }))
	};
}

const STATUS_MARK: Record<TaskStatus, string> = { todo: ' ', done: 'x', blocked: '!' };
const MARK_STATUS: Record<string, TaskStatus> = { ' ': 'todo', x: 'done', '!': 'blocked' };

/**
 * Render the full plan. With phases, items are grouped under `## Phase` headings
 * that carry the verification status and repair count — this file IS the resume
 * path, so everything the loop needs to continue must survive the round trip.
 * With no phases the output is byte-identical to the historical format, so a
 * phaseless run (or an old TODO file) is unaffected.
 */
export function renderTodoPlan(plan: LoopPlan): string {
	const lines: string[] = [
		'# Coding TODO',
		'',
		'Owned by the autonomous-coding run — do not edit while a run is active.',
		'Marks: [ ] todo · [x] done · [!] blocked.',
		''
	];
	const pushItem = (item: TaskItem) => {
		const flags = `attempts: ${item.attempts}${item.repair ? ', repair' : ''}`;
		lines.push(`- [${STATUS_MARK[item.status]}] ${item.id}. ${item.title} (${flags})`);
		for (const dline of item.description.split('\n')) {
			if (dline.trim()) lines.push(`  ${dline.trimEnd()}`);
		}
	};
	if (plan.phases.length === 0) {
		for (const item of plan.items) pushItem(item);
		return lines.join('\n') + '\n';
	}
	// Items whose phase id matches no heading would otherwise vanish from the
	// file — and this file is the resume path, so a vanished item is a lost
	// item. Render them first, un-headed, like the legacy format.
	const known = new Set(plan.phases.map((p) => p.id));
	for (const item of plan.items) {
		if (!item.phase || !known.has(item.phase)) pushItem(item);
	}
	for (const phase of plan.phases) {
		lines.push(
			'',
			`## Phase ${phase.id} — ${phase.title} (verify: ${phase.verify}, repairs: ${phase.repairs})`,
			''
		);
		for (const item of plan.items) {
			if (item.phase === phase.id) pushItem(item);
		}
	}
	return lines.join('\n') + '\n';
}

const ITEM_RE = /^- \[([ x!])\] (\d{2,})\. (.+?)(?: \(attempts: (\d+)(, repair)?\))?$/;
const PHASE_RE = /^## Phase (\d{2,}) — (.+?) \(verify: (pending|passed|blocked), repairs: (\d+)\)$/;

/**
 * Parse a TODO-coding.md back into a plan. Returns null when the text has no
 * parseable items at all (missing/foreign file → not a resumable state).
 * Unknown lines are ignored, so a read-truncation marker can't corrupt the
 * items that did parse. Phase headings assign the items that follow them;
 * items before any heading (or in a legacy file with no headings) are
 * phaseless.
 */
export function parseTodoPlan(text: string): LoopPlan | null {
	const phases: PhaseInfo[] = [];
	const items: TaskItem[] = [];
	let currentPhase: string | undefined;
	let current: TaskItem | null = null;
	for (const line of text.split('\n')) {
		const ph = PHASE_RE.exec(line);
		if (ph) {
			currentPhase = ph[1];
			phases.push({
				id: ph[1],
				title: ph[2].trim(),
				verify: ph[3] as PhaseVerifyStatus,
				repairs: parseInt(ph[4], 10)
			});
			current = null;
			continue;
		}
		const m = ITEM_RE.exec(line);
		if (m) {
			current = {
				id: m[2],
				title: m[3].trim(),
				description: '',
				status: MARK_STATUS[m[1]] ?? 'todo',
				attempts: m[4] ? parseInt(m[4], 10) : 0,
				...(currentPhase !== undefined ? { phase: currentPhase } : {}),
				...(m[5] ? { repair: true } : {})
			};
			items.push(current);
			continue;
		}
		if (current && /^ {2}\S/.test(line)) {
			current.description += (current.description ? '\n' : '') + line.slice(2).trimEnd();
		} else if (line.trim() === '') {
			// blank lines end the current description block
			current = null;
		}
	}
	return items.length > 0 ? { phases, items } : null;
}

/** The item the next iteration should work on: the first 'todo', in order. */
export function nextActionable(items: TaskItem[]): TaskItem | null {
	return items.find((i) => i.status === 'todo') ?? null;
}

/**
 * Mark every item of a phase done — phase-context mode's bulk transition when
 * its build turn ends. "Done" records that the work happened; whether it
 * WORKS is the phase's `verify` status, settled by verification afterwards.
 */
export function markPhaseItemsDone(plan: LoopPlan, phaseId: string): LoopPlan {
	return {
		...plan,
		items: plan.items.map((i) =>
			i.phase === phaseId && i.status === 'todo' ? { ...i, status: 'done' as TaskStatus } : i
		)
	};
}

/** Mark an item done (attempts kept as a record of how hard it was). */
export function markDone(items: TaskItem[], id: string): TaskItem[] {
	return items.map((i) => (i.id === id ? { ...i, status: 'done' as TaskStatus } : i));
}

/**
 * Record one failed attempt; at `maxAttempts` the item transitions to
 * blocked and the loop moves on.
 */
export function recordFailure(
	items: TaskItem[],
	id: string,
	maxAttempts: number
): { items: TaskItem[]; blocked: boolean } {
	let blocked = false;
	const next = items.map((i) => {
		if (i.id !== id) return i;
		const attempts = i.attempts + 1;
		blocked = attempts >= maxAttempts;
		return { ...i, attempts, status: (blocked ? 'blocked' : 'todo') as TaskStatus };
	});
	return { items: next, blocked };
}

/**
 * The phase whose deep verification should run now: verification still
 * pending, it has items, and none of them is still actionable. "No todo
 * items" rather than "all done" on purpose — a repair item that failed its
 * single attempt is blocked, and verification must still re-run after it
 * (the user's contract: re-verify after every repair regardless of what the
 * repair reported, because a partial fix is still a fix).
 */
export function phaseNeedingVerify(plan: LoopPlan): PhaseInfo | null {
	for (const phase of plan.phases) {
		if (phase.verify !== 'pending') continue;
		const members = plan.items.filter((i) => i.phase === phase.id);
		if (members.length === 0) continue;
		if (members.every((i) => i.status !== 'todo')) return phase;
	}
	return null;
}

/** Set a phase's verification outcome. */
export function setPhaseVerify(
	plan: LoopPlan,
	phaseId: string,
	verify: PhaseVerifyStatus
): LoopPlan {
	return {
		...plan,
		phases: plan.phases.map((p) => (p.id === phaseId ? { ...p, verify } : p))
	};
}

/**
 * Start a repair cycle: bump the phase's cycle count and append a repair item
 * carrying the verification failure, placed directly after the phase's last
 * item so `nextActionable` picks it up next.
 *
 * The new id continues from the highest numeric id in the list — existing ids
 * are NEVER renumbered, because PROGRESS notes and commit messages already
 * reference them.
 */
export function beginRepairCycle(
	plan: LoopPlan,
	phaseId: string,
	failureOutput: string
): { plan: LoopPlan; item: TaskItem } {
	const phase = plan.phases.find((p) => p.id === phaseId);
	const cycle = (phase?.repairs ?? 0) + 1;
	const maxId = plan.items.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0);
	const item: TaskItem = {
		id: String(maxId + 1).padStart(2, '0'),
		title: `Repair phase ${phaseId} (cycle ${cycle}/${MAX_PHASE_REPAIR_CYCLES})`,
		description:
			`Phase ${phaseId} verification failed. Diagnose from the output below, fix the ` +
			`cause, and make the phase verification pass. Verification re-runs after this ` +
			`item regardless of the outcome you report. If the verification COMMAND itself ` +
			`is broken (shell errors, wrong path), fix it under "## ${VERIFICATION_COMMAND_HEADING}" in ` +
			`DECISIONS-coding.md — the runner re-reads it before every check.\n\n` +
			`Verification output:\n${clipNote(failureOutput, 3000)}`,
		status: 'todo',
		attempts: 0,
		phase: phaseId,
		repair: true
	};
	const lastIdx = plan.items.reduce((last, i, idx) => (i.phase === phaseId ? idx : last), -1);
	const items = [...plan.items];
	items.splice(lastIdx + 1, 0, item);
	return {
		plan: {
			phases: plan.phases.map((p) => (p.id === phaseId ? { ...p, repairs: cycle } : p)),
			items
		},
		item
	};
}

export interface LoopSummary {
	done: number;
	blocked: number;
	todo: number;
	total: number;
}

export function summarize(items: TaskItem[]): LoopSummary {
	return {
		done: items.filter((i) => i.status === 'done').length,
		blocked: items.filter((i) => i.status === 'blocked').length,
		todo: items.filter((i) => i.status === 'todo').length,
		total: items.length
	};
}

/**
 * Compact one-line-per-item view for iteration prompts: statuses without the
 * descriptions, so the prompt stays flat-sized on a 50-item run (the target
 * item's description rides along separately).
 */
export function renderOverview(items: TaskItem[]): string {
	return items
		.map(
			(i) =>
				`- [${STATUS_MARK[i.status]}] ${i.id}. ${i.title}` +
				(i.attempts > 0 ? ` (attempts: ${i.attempts})` : '')
		)
		.join('\n');
}

/**
 * Bound one progress note for the prompt tail. Full notes still go to
 * PROGRESS-coding.md; this only keeps a runaway diagnostic from blowing up
 * every subsequent iteration's context.
 */
export function clipNote(note: string, maxChars = 1500): string {
	const t = note.trim();
	return t.length <= maxChars
		? t
		: `${t.slice(0, maxChars)}\n[… note truncated for the prompt tail]`;
}
