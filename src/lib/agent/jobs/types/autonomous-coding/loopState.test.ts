import { describe, it, expect } from 'vitest';
import {
	clipNote,
	markDone,
	nextActionable,
	normalizeTaskListPlan,
	recordFailure,
	renderOverview,
	summarize,
	type TaskItem
} from './loopState';

/** The legacy item-only round trip, expressed through the plan API. */
const renderTodoMarkdown = (items: TaskItem[]) => renderTodoPlan({ phases: [], items });
const parseTodoMarkdown = (text: string) => parseTodoPlan(text)?.items ?? null;
const isTerminal = (items: TaskItem[]) => nextActionable(items) === null;

function item(over: Partial<TaskItem> = {}): TaskItem {
	return {
		id: '01',
		title: 'Scaffold the project',
		description: 'Vite + TS; `npm run build` passes.',
		status: 'todo',
		attempts: 0,
		...over
	};
}

describe('normalizeTaskListPlan', () => {
	it('assigns two-digit position ids and drops junk entries', () => {
		const plan = normalizeTaskListPlan([
			{ title: '  Scaffold  the   project ', description: ' desc ', phase: 'Setup' },
			{ title: '' },
			'not an object',
			{ description: 'no title' },
			{ title: 'Add router', phase: 'Setup' }
		]);
		expect(plan.items).toHaveLength(2);
		expect(plan.items[0]).toMatchObject({
			id: '01',
			title: 'Scaffold the project',
			description: 'desc',
			status: 'todo',
			attempts: 0
		});
		expect(plan.items[1].id).toBe('02');
	});

	it('groups items into phases by title, first-appearance order', () => {
		const plan = normalizeTaskListPlan([
			{ title: 'a', phase: 'Engine' },
			{ title: 'b', phase: 'UI' },
			{ title: 'c', phase: 'engine' } // case-insensitive match
		]);
		expect(plan.phases.map((p) => p.title)).toEqual(['Engine', 'UI']);
		expect(plan.items.map((i) => i.phase)).toEqual(['01', '02', '01']);
	});

	it('gathers unphased items into a catch-all so verification still runs', () => {
		// A phaseless item would never sit inside a verification boundary.
		const plan = normalizeTaskListPlan([{ title: 'a' }, { title: 'b', phase: 'Real' }]);
		expect(plan.items[0].phase).toBeDefined();
		expect(plan.phases).toHaveLength(2);
	});

	it('returns an empty plan for non-arrays', () => {
		expect(normalizeTaskListPlan(null)).toEqual({ phases: [], items: [] });
		expect(normalizeTaskListPlan({ items: [] })).toEqual({ phases: [], items: [] });
	});
});

describe('TODO markdown round-trip', () => {
	it('render → parse is lossless for status, attempts, titles, descriptions', () => {
		const items: TaskItem[] = [
			item(),
			item({
				id: '02',
				title: 'Add the API layer',
				description: 'REST endpoints.\nCovered by integration tests.',
				status: 'done',
				attempts: 2
			}),
			item({ id: '03', title: 'Wire auth', description: '', status: 'blocked', attempts: 3 })
		];
		const parsed = parseTodoMarkdown(renderTodoMarkdown(items));
		expect(parsed).toEqual(items);
	});

	it('parse ignores foreign lines (headers, truncation markers) between items', () => {
		const text = [
			'# Coding TODO',
			'',
			'- [ ] 01. First (attempts: 1)',
			'  do the thing',
			'',
			'[... file truncated ...]',
			'- [x] 02. Second (attempts: 0)'
		].join('\n');
		const parsed = parseTodoMarkdown(text)!;
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({ id: '01', attempts: 1, description: 'do the thing' });
		expect(parsed[1]).toMatchObject({ id: '02', status: 'done' });
	});

	it('returns null when nothing parses (missing/foreign file → not resumable)', () => {
		expect(parseTodoMarkdown('')).toBeNull();
		expect(parseTodoMarkdown('# some other markdown\n\njust prose')).toBeNull();
	});
});

describe('loop transitions', () => {
	it('nextActionable picks the first todo in order, skipping done/blocked', () => {
		const items = [
			item({ id: '01', status: 'done' }),
			item({ id: '02', status: 'blocked' }),
			item({ id: '03' }),
			item({ id: '04' })
		];
		expect(nextActionable(items)?.id).toBe('03');
	});

	it('markDone flips status and keeps the attempt record', () => {
		const items = markDone([item({ attempts: 2 })], '01');
		expect(items[0]).toMatchObject({ status: 'done', attempts: 2 });
	});

	it('recordFailure increments attempts and blocks at the max', () => {
		const items = [item()];
		let r = recordFailure(items, '01', 3);
		expect(r.blocked).toBe(false);
		expect(r.items[0]).toMatchObject({ status: 'todo', attempts: 1 });

		r = recordFailure(r.items, '01', 3);
		expect(r.blocked).toBe(false);

		r = recordFailure(r.items, '01', 3);
		expect(r.blocked).toBe(true);
		expect(r.items[0]).toMatchObject({ status: 'blocked', attempts: 3 });
	});

	it('terminal when every item is done or blocked — the "no cap" loop is structurally bounded', () => {
		const items = [item({ status: 'done' }), item({ id: '02', status: 'blocked' })];
		expect(isTerminal(items)).toBe(true);
		expect(summarize(items)).toEqual({ done: 1, blocked: 1, todo: 0, total: 2 });
		expect(isTerminal([...items, item({ id: '03' })])).toBe(false);
	});
});

describe('prompt-size bounding', () => {
	it('renderOverview is one line per item, no descriptions, attempts only when > 0', () => {
		const overview = renderOverview([
			item({ description: 'a very long description that must not appear' }),
			item({ id: '02', title: 'Second', status: 'blocked', attempts: 3 })
		]);
		expect(overview).toBe('- [ ] 01. Scaffold the project\n- [!] 02. Second (attempts: 3)');
		expect(overview).not.toContain('very long description');
	});

	it('clipNote passes short notes through and truncates runaway ones with a marker', () => {
		expect(clipNote('  fine  ')).toBe('fine');
		const clipped = clipNote('x'.repeat(5000));
		expect(clipped.length).toBeLessThan(1600);
		expect(clipped).toContain('truncated for the prompt tail');
	});
});

// ---------------------------------------------------------------------------
// Phase-aware state. TODO-coding.md is the resume path — the plan dir, not the
// DB, carries loop state — so everything below must survive the round trip.

import {
	beginRepairCycle,
	markPhaseItemsDone,
	parseTodoPlan,
	phaseNeedingVerify,
	renderTodoPlan,
	setPhaseVerify,
	MAX_PHASE_REPAIR_CYCLES,
	type LoopPlan
} from './loopState';

function planFixture(): LoopPlan {
	return {
		phases: [
			{ id: '01', title: 'Scaffold', verify: 'pending', repairs: 0 },
			{ id: '02', title: 'Engine', verify: 'pending', repairs: 0 }
		],
		items: [
			{
				id: '01',
				title: 'Create index.html',
				description: 'skeleton',
				status: 'done',
				attempts: 0,
				phase: '01'
			},
			{
				id: '02',
				title: 'Word list',
				description: '300 words',
				status: 'done',
				attempts: 1,
				phase: '01'
			},
			{
				id: '03',
				title: 'GameState class',
				description: 'engine',
				status: 'todo',
				attempts: 0,
				phase: '02'
			}
		]
	};
}

describe('phase round trip', () => {
	it('renders and parses phases, statuses and repair counts losslessly', () => {
		let plan = planFixture();
		plan = setPhaseVerify(plan, '01', 'passed');
		plan = { ...plan, phases: plan.phases.map((p) => (p.id === '02' ? { ...p, repairs: 2 } : p)) };
		const back = parseTodoPlan(renderTodoPlan(plan));
		expect(back).toEqual(plan);
	});

	it('round-trips the repair flag on an item', () => {
		const { plan } = beginRepairCycle(planFixture(), '01', 'boom');
		const back = parseTodoPlan(renderTodoPlan(plan))!;
		const repair = back.items.find((i) => i.repair);
		expect(repair).toBeDefined();
		expect(repair!.phase).toBe('01');
	});

	it('parses a legacy phaseless file exactly as before', () => {
		const legacy = [
			'# Coding TODO',
			'',
			'- [x] 01. Old item (attempts: 0)',
			'  did the thing',
			'- [ ] 02. Next item (attempts: 1)'
		].join('\n');
		const plan = parseTodoPlan(legacy)!;
		expect(plan.phases).toEqual([]);
		expect(plan.items).toHaveLength(2);
		expect(plan.items[0].phase).toBeUndefined();
	});

	it('emits the historical format when there are no phases', () => {
		// A phaseless run must produce a file an older build could still parse.
		const out = renderTodoPlan({ phases: [], items: planFixture().items });
		expect(out).not.toContain('## Phase');
		expect(out).toContain('- [x] 01. Create index.html (attempts: 0)');
	});

	it('keeps an item whose phase id matches no heading (the resume path must not lose items)', () => {
		const plan = planFixture();
		plan.items.push({
			id: '04',
			title: 'Orphan',
			description: '',
			status: 'todo',
			attempts: 0,
			phase: '99'
		});
		const back = parseTodoPlan(renderTodoPlan(plan))!;
		expect(back.items.map((i) => i.title)).toContain('Orphan');
	});
});

describe('phaseNeedingVerify', () => {
	it('is null while every pending phase still has actionable items', () => {
		const plan = planFixture();
		plan.items[1].status = 'todo'; // phase 01 back in progress
		expect(phaseNeedingVerify(plan)).toBeNull();
	});

	it('fires for a completed phase even while a later phase still has work', () => {
		// Verification happens at each phase boundary as it is crossed, not at
		// the end of the run — the fixture has phase 01 done and phase 02 open.
		expect(phaseNeedingVerify(planFixture())!.id).toBe('01');
	});

	it('still fires when a repair item is blocked rather than done', () => {
		// The user's contract: verification re-runs after every repair attempt
		// regardless of the outcome it reported — a partial fix is still a fix.
		let plan = planFixture();
		plan.items = plan.items.map((i) => ({ ...i, status: 'done' as const }));
		plan = setPhaseVerify(plan, '01', 'passed');
		const injected = beginRepairCycle(plan, '02', 'assertion failed');
		injected.plan.items = injected.plan.items.map((i) =>
			i.repair ? { ...i, status: 'blocked' as const } : i
		);
		expect(phaseNeedingVerify(injected.plan)!.id).toBe('02');
	});

	it('skips phases already passed or blocked', () => {
		let plan = planFixture();
		plan.items = plan.items.map((i) => ({ ...i, status: 'done' as const }));
		plan = setPhaseVerify(plan, '01', 'passed');
		plan = setPhaseVerify(plan, '02', 'blocked');
		expect(phaseNeedingVerify(plan)).toBeNull();
	});
});

describe('beginRepairCycle', () => {
	it('appends after the phase tail, never renumbering existing ids', () => {
		// PROGRESS notes and commit messages already reference the old ids.
		const before = planFixture();
		const { plan, item } = beginRepairCycle(before, '01', 'stack trace here');
		expect(plan.items.map((i) => i.id)).toEqual(['01', '02', '04', '03']);
		expect(item.id).toBe('04');
		expect(plan.items[2]).toBe(item); // directly after phase 01's last item
	});

	it('carries the failure output into the repair item description', () => {
		const { item } = beginRepairCycle(planFixture(), '01', 'Expected 6, got 5');
		expect(item.description).toContain('Expected 6, got 5');
		expect(item.repair).toBe(true);
	});

	it('counts cycles on the phase and names the budget in the title', () => {
		const first = beginRepairCycle(planFixture(), '01', 'a');
		const second = beginRepairCycle(first.plan, '01', 'b');
		expect(second.plan.phases[0].repairs).toBe(2);
		expect(second.item.title).toContain(`2/${MAX_PHASE_REPAIR_CYCLES}`);
	});

	it('clips a runaway failure output', () => {
		const { item } = beginRepairCycle(planFixture(), '01', 'x'.repeat(20_000));
		expect(item.description.length).toBeLessThan(4000);
	});
});

describe('markPhaseItemsDone', () => {
	it("transitions only the phase's todo items, leaving blocked ones alone", () => {
		const p = planFixture();
		p.items[1].status = 'blocked';
		p.items[0].status = 'todo';
		const out = markPhaseItemsDone(p, '01');
		expect(out.items.map((i) => i.status)).toEqual(['done', 'blocked', 'todo']);
	});
});
