import { describe, it, expect } from 'vitest';
import type { JobSummary } from '#lib/stores/jobs.svelte.ts';
import { ancestorIds, buildJobTree, containsJob, filterJobTree, flattenJobTree } from './jobTree';

function job(id: number, over: Partial<JobSummary> = {}): JobSummary {
	return {
		id,
		name: `Job ${id}`,
		description: null,
		working_dir: '/w',
		auto_approve_tools: false,
		job_type: 'research',
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		created_at: id,
		updated_at: id,
		step_count: 1,
		parent_job_id: null,
		parent_run_id: null,
		...over
	};
}

/** Planning (1) started assets (2), which started coding (3). */
const chain = [
	job(1, { name: 'Hangman plan', job_type: 'guided_planning', updated_at: 10 }),
	job(2, { name: 'Hangman plan — assets', parent_job_id: 1, parent_run_id: 5, updated_at: 20 }),
	job(3, { name: 'Hangman plan — coding', parent_job_id: 2, parent_run_id: 6, updated_at: 30 }),
	job(4, { name: 'Morning headlines', updated_at: 25 })
];

const ids = (rows: { node: { job: { id: number } } }[]) => rows.map((r) => r.node.job.id);

describe('buildJobTree', () => {
	it('nests a job under the one that started it', () => {
		const roots = buildJobTree(chain);
		expect(roots.map((r) => r.job.id)).toEqual([1, 4]);
		expect(roots[0].children[0].job.id).toBe(2);
		expect(roots[0].children[0].children[0].job.id).toBe(3);
		expect(roots[0].descendants).toBe(2);
	});

	it('sorts roots by the newest activity below them', () => {
		// Job 1 itself is older than job 4, but its coding job ran last.
		const roots = buildJobTree(chain);
		expect(roots[0].activity).toBe(30);
		expect(roots[0].job.id).toBe(1);
	});

	it('puts a job whose parent is gone at the top level', () => {
		const roots = buildJobTree([job(2, { parent_job_id: 99 })]);
		expect(roots.map((r) => r.job.id)).toEqual([2]);
	});

	it('survives a parent loop', () => {
		const roots = buildJobTree([job(1, { parent_job_id: 2 }), job(2, { parent_job_id: 1 })]);
		// Both are reachable, neither twice.
		const all = flattenJobTree(roots, () => true).map((r) => r.node.job.id);
		expect(all.sort()).toEqual([1, 2]);
	});

	it('lists the newest of several runs first', () => {
		const roots = buildJobTree([
			job(1),
			job(2, { parent_job_id: 1, created_at: 100 }),
			job(3, { parent_job_id: 1, created_at: 200 })
		]);
		expect(roots[0].children.map((c) => c.job.id)).toEqual([3, 2]);
	});
});

describe('flattenJobTree', () => {
	it('hides children until their parent is opened', () => {
		const roots = buildJobTree(chain);
		expect(ids(flattenJobTree(roots, () => false))).toEqual([1, 4]);
		expect(ids(flattenJobTree(roots, (id) => id === 1))).toEqual([1, 2, 4]);
		const rows = flattenJobTree(roots, () => true);
		expect(ids(rows)).toEqual([1, 2, 3, 4]);
		expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 0]);
	});
});

describe('filterJobTree', () => {
	const roots = buildJobTree(chain);

	it('shows a matching child with the jobs above it, opened', () => {
		const rows = flattenJobTree(filterJobTree(roots, 'coding'), () => false);
		expect(ids(rows)).toEqual([1, 2, 3]);
	});

	it('keeps what is below a matching job, closed until opened', () => {
		const filtered = filterJobTree(roots, 'hangman plan');
		expect(ids(flattenJobTree(filtered, () => false))).toEqual([1]);
	});

	it('matches every word, in any order, ignoring case', () => {
		expect(filterJobTree(roots, 'HEADLINES morning').map((r) => r.job.id)).toEqual([4]);
		expect(filterJobTree(roots, 'morning plan')).toEqual([]);
	});

	it('matches the extra text, such as the type label', () => {
		const filtered = filterJobTree(roots, 'plan', (j) =>
			j.job_type === 'guided_planning' ? 'Plan' : ''
		);
		expect(filtered.map((r) => r.job.id)).toEqual([1]);
	});

	it('returns everything for a blank query', () => {
		expect(filterJobTree(roots, '  ')).toBe(roots);
	});
});

describe('containsJob and ancestorIds', () => {
	it('finds a job at any depth', () => {
		const [plan, headlines] = buildJobTree(chain);
		expect(containsJob(plan, 3)).toBe(true);
		expect(containsJob(headlines, 3)).toBe(false);
	});

	it('lists the jobs above, nearest first', () => {
		expect(ancestorIds(chain, 3)).toEqual([2, 1]);
		expect(ancestorIds(chain, 4)).toEqual([]);
	});
});
