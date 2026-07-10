import { describe, it, expect } from 'vitest';
import { clusterFindings, parseLineRange } from './auditCluster';
import type { AuditFinding } from '$lib/agent/tools/audit';

function f(partial: Partial<AuditFinding> & { file: string; title: string }): AuditFinding {
	return { severity: 'medium', ...partial };
}

describe('parseLineRange', () => {
	it('parses single lines, ranges, and dash variants', () => {
		expect(parseLineRange('12')).toEqual({ start: 12, end: 12 });
		expect(parseLineRange('12-40')).toEqual({ start: 12, end: 40 });
		expect(parseLineRange(' 12 - 40 ')).toEqual({ start: 12, end: 40 });
		expect(parseLineRange('12–40')).toEqual({ start: 12, end: 40 }); // en-dash
	});

	it('swaps reversed ranges and rejects junk/empty', () => {
		expect(parseLineRange('40-12')).toEqual({ start: 12, end: 40 });
		expect(parseLineRange(null)).toBeNull();
		expect(parseLineRange(undefined)).toBeNull();
		expect(parseLineRange('')).toBeNull();
		expect(parseLineRange('whole file')).toBeNull();
	});
});

describe('clusterFindings', () => {
	it('returns nothing for empty input', () => {
		expect(clusterFindings([])).toEqual([]);
		expect(clusterFindings([[], []])).toEqual([]);
	});

	it('merges overlapping line ranges in the same file and counts distinct runs', () => {
		const clusters = clusterFindings([
			[f({ file: 'a.rs', lines: '10-20', title: 'dup A' })],
			[f({ file: 'a.rs', lines: '15-25', title: 'duplicated logic' })],
			[f({ file: 'a.rs', lines: '100', title: 'unrelated' })]
		]);
		expect(clusters).toHaveLength(2);
		const merged = clusters.find((c) => c.lineStart === 10)!;
		expect(merged.consensus).toBe(2);
		expect(merged.members).toHaveLength(2);
		expect(merged.lineEnd).toBe(25); // spans both ranges
	});

	it('merges adjacent ranges within the gap but not beyond it', () => {
		const near = clusterFindings([
			[f({ file: 'x.go', lines: '10-12', title: 'a' })],
			[f({ file: 'x.go', lines: '15-18', title: 'b' })] // gap of 3
		]);
		expect(near).toHaveLength(1);

		const far = clusterFindings([
			[f({ file: 'x.go', lines: '10-12', title: 'a' })],
			[f({ file: 'x.go', lines: '40-42', title: 'b' })]
		]);
		expect(far).toHaveLength(2);
	});

	it('clusters same-location findings even when titles differ (location wins)', () => {
		const clusters = clusterFindings([
			[f({ file: 'a.rs', lines: '10', title: 'copy-paste block' })],
			[f({ file: 'a.rs', lines: '10', title: 'totally different words here' })]
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].consensus).toBe(2);
	});

	it('never merges findings across different files', () => {
		const clusters = clusterFindings([
			[f({ file: 'a.rs', lines: '10', title: 'identical title' })],
			[f({ file: 'b.rs', lines: '10', title: 'identical title' })]
		]);
		expect(clusters).toHaveLength(2);
		expect(clusters.every((c) => c.consensus === 1)).toBe(true);
	});

	it('merges file-level findings by title similarity, splits dissimilar ones', () => {
		const clusters = clusterFindings([
			[f({ file: 'm.go', title: 'itoa and ftoa are underused wrappers' })],
			[f({ file: 'm.go', title: 'itoa ftoa underused wrappers' })],
			[f({ file: 'm.go', title: 'spec decoding flag emission duplicated' })]
		]);
		expect(clusters).toHaveLength(2);
		const wrappers = clusters.find((c) => c.title.includes('underused'))!;
		expect(wrappers.consensus).toBe(2);
		expect(wrappers.lineStart).toBeNull(); // file-level
	});

	it('merges by title even when line numbers are far apart (mislabeled lines)', () => {
		const clusters = clusterFindings([
			[f({ file: 'r.go', lines: '10', title: 'router load unload duplicated' })],
			[f({ file: 'r.go', lines: '900', title: 'router load unload duplicated' })]
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].lineStart).toBe(10);
		expect(clusters[0].lineEnd).toBe(900);
	});

	it('takes max severity, dominant category, and the strongest member title', () => {
		const clusters = clusterFindings([
			[f({ file: 'a.rs', lines: '10', title: 'minor note', severity: 'low', category: 'style' })],
			[
				f({
					file: 'a.rs',
					lines: '11',
					title: 'serious duplication of the parser',
					severity: 'high',
					category: 'duplication',
					detail: 'long detailed explanation'
				})
			],
			[f({ file: 'a.rs', lines: '12', title: 'dup', severity: 'medium', category: 'duplication' })]
		]);
		expect(clusters).toHaveLength(1);
		const c = clusters[0];
		expect(c.severity).toBe('high');
		expect(c.category).toBe('duplication');
		expect(c.title).toBe('serious duplication of the parser'); // strongest member
	});

	it('does not double-count consensus when one run reports the spot twice', () => {
		const clusters = clusterFindings([
			[
				f({ file: 'a.rs', lines: '10-12', title: 'dup here' }),
				f({ file: 'a.rs', lines: '11-13', title: 'dup again' })
			]
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].members).toHaveLength(2);
		expect(clusters[0].consensus).toBe(1); // both from run 0
	});

	it('normalizes paths so "./a.rs" and "a.rs" cluster together', () => {
		const clusters = clusterFindings([
			[f({ file: './a.rs', lines: '10', title: 'x' })],
			[f({ file: 'a.rs', lines: '10', title: 'y' })]
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].file).toBe('a.rs');
	});

	it('sorts by consensus desc, then severity desc', () => {
		const clusters = clusterFindings([
			[f({ file: 'a.rs', lines: '10', title: 'low agreement high sev', severity: 'high' })],
			[f({ file: 'b.rs', lines: '10', title: 'high agreement', severity: 'low' })],
			[f({ file: 'b.rs', lines: '10', title: 'high agreement', severity: 'low' })]
		]);
		// b.rs cluster has consensus 2, a.rs has 1 → b first despite lower severity.
		expect(clusters[0].file).toBe('b.rs');
		expect(clusters[0].consensus).toBe(2);
		expect(clusters[1].file).toBe('a.rs');
	});
});
