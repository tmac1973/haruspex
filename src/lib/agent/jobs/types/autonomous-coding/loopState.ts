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
}

/** Normalize a submit_task_list payload: position ids, trimmed, empties dropped. */
export function normalizeTaskList(raw: unknown): TaskItem[] {
	if (!Array.isArray(raw)) return [];
	const items: TaskItem[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') continue;
		const e = entry as Record<string, unknown>;
		const title = typeof e.title === 'string' ? e.title.replace(/\s+/g, ' ').trim() : '';
		if (!title) continue;
		const description = typeof e.description === 'string' ? e.description.trim() : '';
		items.push({
			id: String(items.length + 1).padStart(2, '0'),
			title,
			description,
			status: 'todo',
			attempts: 0
		});
	}
	return items;
}

const STATUS_MARK: Record<TaskStatus, string> = { todo: ' ', done: 'x', blocked: '!' };
const MARK_STATUS: Record<string, TaskStatus> = { ' ': 'todo', x: 'done', '!': 'blocked' };

/**
 * Render the checklist. Format (one item):
 *
 *     - [ ] 01. Title (attempts: 0)
 *       description line(s), indented two spaces
 *
 * Marks: `[ ]` todo, `[x]` done, `[!]` blocked.
 */
export function renderTodoMarkdown(items: TaskItem[]): string {
	const lines: string[] = [
		'# Coding TODO',
		'',
		'Owned by the autonomous-coding run — do not edit while a run is active.',
		'Marks: [ ] todo · [x] done · [!] blocked.',
		''
	];
	for (const item of items) {
		lines.push(
			`- [${STATUS_MARK[item.status]}] ${item.id}. ${item.title} (attempts: ${item.attempts})`
		);
		for (const dline of item.description.split('\n')) {
			if (dline.trim()) lines.push(`  ${dline.trimEnd()}`);
		}
	}
	return lines.join('\n') + '\n';
}

const ITEM_RE = /^- \[([ x!])\] (\d{2,})\. (.+?)(?: \(attempts: (\d+)\))?$/;

/**
 * Parse a TODO-coding.md back into items. Returns null when the text has no
 * parseable items at all (missing/foreign file → not a resumable state).
 * Unknown lines are ignored, so a read-truncation marker can't corrupt the
 * items that did parse.
 */
export function parseTodoMarkdown(text: string): TaskItem[] | null {
	const items: TaskItem[] = [];
	let current: TaskItem | null = null;
	for (const line of text.split('\n')) {
		const m = ITEM_RE.exec(line);
		if (m) {
			current = {
				id: m[2],
				title: m[3].trim(),
				description: '',
				status: MARK_STATUS[m[1]] ?? 'todo',
				attempts: m[4] ? parseInt(m[4], 10) : 0
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
	return items.length > 0 ? items : null;
}

/** The item the next iteration should work on: the first 'todo', in order. */
export function nextActionable(items: TaskItem[]): TaskItem | null {
	return items.find((i) => i.status === 'todo') ?? null;
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

/** True when nothing is left to attempt (every item done or blocked). */
export function isTerminal(items: TaskItem[]): boolean {
	return nextActionable(items) === null;
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
