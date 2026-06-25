/**
 * Cluster audit findings across the N independent sample runs.
 *
 * Each sample run emits its own list of findings (via `submit_findings`). The
 * same underlying issue is usually reported by several runs, with slightly
 * different wording and line numbers. To turn N noisy lists into one clean set
 * we group findings that refer to the same place, so the downstream
 * verification pass checks each distinct issue once and the report can show how
 * many runs agreed (the consensus signal).
 *
 * Clustering is deterministic and location-first: findings only ever merge
 * within the same file, and merge when their line ranges overlap/are adjacent
 * OR their titles are similar (a fuzzy fallback for file-level findings and for
 * runs that mislabel line numbers). Cross-file findings never merge — a finding
 * is anchored to one location, and that location is the dedup key.
 */

import type { AuditFinding, FindingSeverity } from '$lib/agent/tools/audit';

/** A finding paired with the index of the sample run that produced it. */
export interface ClusterMember extends AuditFinding {
	run: number;
}

export interface FindingCluster {
	file: string;
	/** Merged line span across members, or null when every member is file-level. */
	lineStart: number | null;
	lineEnd: number | null;
	/** Representative title (from the strongest member). */
	title: string;
	/** Highest severity among members. */
	severity: FindingSeverity;
	/** Most common non-empty category among members, or null. */
	category: string | null;
	/** Number of DISTINCT sample runs that surfaced this cluster. */
	consensus: number;
	members: ClusterMember[];
}

export interface ClusterOptions {
	/** Max gap (in lines) between two ranges for them to count as adjacent. */
	lineGap?: number;
	/** Min token-Jaccard for two titles to count as "the same issue". */
	titleSimilarity?: number;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
	high: 3,
	medium: 2,
	low: 1,
	trivial: 0
};

interface LineRange {
	start: number;
	end: number;
}

/** Parse "12" / "12-40" / "12–40" / " 12 - 40 " into a range; null if absent/unparseable. */
export function parseLineRange(lines: string | null | undefined): LineRange | null {
	if (!lines) return null;
	const m = lines.replace(/[–—]/g, '-').match(/(\d+)\s*(?:-\s*(\d+))?/);
	if (!m) return null;
	const start = Number(m[1]);
	const end = m[2] !== undefined ? Number(m[2]) : start;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	return start <= end ? { start, end } : { start: end, end: start };
}

/** Normalize a repo-relative path: trim, drop "./" prefix, unify separators. */
function normalizeFile(file: string): string {
	return file.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Lowercase + strip to alphanumeric tokens for fuzzy title comparison. */
function titleTokens(title: string): Set<string> {
	return new Set(
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.split(' ')
			.filter((t) => t.length > 0)
	);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/** Two ranges overlap or sit within `gap` lines of each other. */
function rangesNear(a: LineRange, b: LineRange, gap: number): boolean {
	if (a.start <= b.end && b.start <= a.end) return true; // overlap
	const distance = a.end < b.start ? b.start - a.end : a.start - b.end;
	return distance <= gap;
}

/** Disjoint-set forest for connected-component clustering. */
class UnionFind {
	private parent: number[];
	constructor(n: number) {
		this.parent = Array.from({ length: n }, (_, i) => i);
	}
	find(x: number): number {
		let root = x;
		while (this.parent[root] !== root) root = this.parent[root];
		// Path compression.
		while (this.parent[x] !== root) {
			const next = this.parent[x];
			this.parent[x] = root;
			x = next;
		}
		return root;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
	}
}

interface Indexed {
	finding: ClusterMember;
	range: LineRange | null;
	tokens: Set<string>;
}

/** Pick the representative member: strongest severity, then richest detail. */
function strongest(members: ClusterMember[]): ClusterMember {
	return members.reduce((best, m) => {
		const bs = SEVERITY_RANK[best.severity];
		const ms = SEVERITY_RANK[m.severity];
		if (ms !== bs) return ms > bs ? m : best;
		const bd = (best.detail ?? '').length;
		const md = (m.detail ?? '').length;
		if (md !== bd) return md > bd ? m : best;
		return m.title.length > best.title.length ? m : best;
	});
}

/** Most common non-empty category among members, ties broken by first seen. */
function dominantCategory(members: ClusterMember[]): string | null {
	const counts = new Map<string, number>();
	for (const m of members) {
		const c = m.category?.trim();
		if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestN = 0;
	for (const [c, n] of counts) {
		if (n > bestN) {
			best = c;
			bestN = n;
		}
	}
	return best;
}

/**
 * Cluster the per-run finding lists into deduplicated issues.
 *
 * @param runs One findings array per sample run (`runs[i]` = run i's findings).
 * @returns Clusters sorted by consensus desc, then severity desc, then location.
 */
export function clusterFindings(
	runs: AuditFinding[][],
	opts: ClusterOptions = {}
): FindingCluster[] {
	const lineGap = opts.lineGap ?? 3;
	const titleSim = opts.titleSimilarity ?? 0.5;

	// Flatten + tag with run index, then bucket by normalized file.
	const byFile = new Map<string, Indexed[]>();
	runs.forEach((findings, run) => {
		for (const f of findings) {
			const file = normalizeFile(f.file);
			const member: ClusterMember = { ...f, file, run };
			const entry: Indexed = {
				finding: member,
				range: parseLineRange(f.lines),
				tokens: titleTokens(f.title)
			};
			const bucket = byFile.get(file);
			if (bucket) bucket.push(entry);
			else byFile.set(file, [entry]);
		}
	});

	const clusters: FindingCluster[] = [];

	for (const entries of byFile.values()) {
		// Connected components: edge when same location OR similar title.
		const uf = new UnionFind(entries.length);
		for (let i = 0; i < entries.length; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				const a = entries[i];
				const b = entries[j];
				const nearByLine =
					a.range !== null && b.range !== null && rangesNear(a.range, b.range, lineGap);
				const nearByTitle = jaccard(a.tokens, b.tokens) >= titleSim;
				if (nearByLine || nearByTitle) uf.union(i, j);
			}
		}

		const groups = new Map<number, ClusterMember[]>();
		const ranges = new Map<number, Array<LineRange | null>>();
		entries.forEach((e, i) => {
			const root = uf.find(i);
			(groups.get(root) ?? groups.set(root, []).get(root)!).push(e.finding);
			(ranges.get(root) ?? ranges.set(root, []).get(root)!).push(e.range);
		});

		for (const [root, members] of groups) {
			const memberRanges = ranges.get(root)!.filter((r): r is LineRange => r !== null);
			const lineStart = memberRanges.length ? Math.min(...memberRanges.map((r) => r.start)) : null;
			const lineEnd = memberRanges.length ? Math.max(...memberRanges.map((r) => r.end)) : null;
			const rep = strongest(members);
			clusters.push({
				file: rep.file,
				lineStart,
				lineEnd,
				title: rep.title,
				severity: members.reduce<FindingSeverity>(
					(s, m) => (SEVERITY_RANK[m.severity] > SEVERITY_RANK[s] ? m.severity : s),
					'trivial'
				),
				category: dominantCategory(members),
				consensus: new Set(members.map((m) => m.run)).size,
				members
			});
		}
	}

	// Stable, useful ordering: most-agreed + most-severe first.
	clusters.sort(
		(a, b) =>
			b.consensus - a.consensus ||
			SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
			a.file.localeCompare(b.file) ||
			(a.lineStart ?? Infinity) - (b.lineStart ?? Infinity)
	);

	return clusters;
}
