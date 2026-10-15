/**
 * The Jobs list as a tree: a job a run created (guided planning → assets →
 * coding) sits under the job that created it. Pure, so the list component
 * only renders.
 */
import type { JobSummary } from '#lib/stores/jobs.svelte.ts';

export interface JobNode {
	job: JobSummary;
	/** Newest first. */
	children: JobNode[];
	/** The latest `updated_at` anywhere in this subtree. */
	activity: number;
	/** Every job below this one, at any depth. */
	descendants: number;
	/**
	 * Kept by a filter only because a job below it matched. The list shows
	 * such a node open, so the match is visible.
	 */
	viaDescendant?: boolean;
}

export interface JobRow {
	node: JobNode;
	depth: number;
	/** Whether its children are showing. */
	open: boolean;
}

/**
 * Nest jobs under their parents. A job whose parent is missing, or whose
 * parent chain loops back on itself, is a root. Roots sort by the newest
 * activity in their subtree, so a chain that is running rises to the top.
 */
export function buildJobTree(jobs: JobSummary[]): JobNode[] {
	const byId = new Map(jobs.map((j) => [j.id, j]));

	const parentOf = (job: JobSummary): number | null => {
		const pid = job.parent_job_id;
		if (pid === null || !byId.has(pid)) return null;
		// Walk up: a loop makes this job a root rather than an orphan forever.
		const seen = new Set([job.id]);
		let cur: number | null = pid;
		while (cur !== null) {
			if (seen.has(cur)) return null;
			seen.add(cur);
			const next: number | null = byId.get(cur)?.parent_job_id ?? null;
			cur = next !== null && byId.has(next) ? next : null;
		}
		return pid;
	};

	const nodes = new Map<number, JobNode>(
		jobs.map((j) => [j.id, { job: j, children: [], activity: j.updated_at, descendants: 0 }])
	);
	const roots: JobNode[] = [];
	for (const j of jobs) {
		const node = nodes.get(j.id)!;
		const pid = parentOf(j);
		if (pid === null) roots.push(node);
		else nodes.get(pid)!.children.push(node);
	}

	const settle = (node: JobNode): void => {
		for (const c of node.children) {
			settle(c);
			node.activity = Math.max(node.activity, c.activity);
			node.descendants += 1 + c.descendants;
		}
		node.children.sort((a, b) => b.job.created_at - a.job.created_at);
	};
	roots.forEach(settle);
	roots.sort((a, b) => b.activity - a.activity);
	return roots;
}

/**
 * The jobs whose name, description or `extra` text (the type's badge label)
 * contains every word of `query`, with the jobs above them. A matching job
 * keeps everything below it.
 */
export function filterJobTree(
	roots: JobNode[],
	query: string,
	extra: (job: JobSummary) => string = () => ''
): JobNode[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return roots;
	const matches = (job: JobSummary) => {
		const text = `${job.name}\n${job.description ?? ''}\n${extra(job)}`.toLowerCase();
		return words.every((w) => text.includes(w));
	};
	const walk = (node: JobNode): JobNode | null => {
		if (matches(node.job)) return node;
		const children = node.children.map(walk).filter((c): c is JobNode => c !== null);
		return children.length ? { ...node, children, viaDescendant: true } : null;
	};
	return roots.map(walk).filter((n): n is JobNode => n !== null);
}

/** The rows to draw, in order: a node's children follow it when it is open. */
export function flattenJobTree(roots: JobNode[], isOpen: (id: number) => boolean): JobRow[] {
	const rows: JobRow[] = [];
	const walk = (node: JobNode, depth: number) => {
		const open = node.children.length > 0 && (node.viaDescendant === true || isOpen(node.job.id));
		rows.push({ node, depth, open });
		if (open) node.children.forEach((c) => walk(c, depth + 1));
	};
	roots.forEach((r) => walk(r, 0));
	return rows;
}

/** Whether `id` is anywhere below `node`. */
export function containsJob(node: JobNode, id: number): boolean {
	return node.children.some((c) => c.job.id === id || containsJob(c, id));
}

/** The ids above `id`, nearest first. */
export function ancestorIds(jobs: JobSummary[], id: number): number[] {
	const byId = new Map(jobs.map((j) => [j.id, j]));
	const out: number[] = [];
	let cur = byId.get(id)?.parent_job_id ?? null;
	while (cur !== null && byId.has(cur) && !out.includes(cur) && cur !== id) {
		out.push(cur);
		cur = byId.get(cur)?.parent_job_id ?? null;
	}
	return out;
}
