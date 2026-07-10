import { describe, it, expect } from 'vitest';
import {
	isTerminal,
	markDone,
	nextActionable,
	normalizeTaskList,
	parseTodoMarkdown,
	recordFailure,
	renderTodoMarkdown,
	summarize,
	type TaskItem
} from './loopState';

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

describe('normalizeTaskList', () => {
	it('assigns two-digit position ids and drops junk entries', () => {
		const items = normalizeTaskList([
			{ title: '  Scaffold  the   project ', description: ' desc ' },
			{ title: '' },
			'not an object',
			{ description: 'no title' },
			{ title: 'Add router' }
		]);
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({
			id: '01',
			title: 'Scaffold the project',
			description: 'desc',
			status: 'todo',
			attempts: 0
		});
		expect(items[1].id).toBe('02');
	});

	it('returns [] for non-arrays', () => {
		expect(normalizeTaskList(null)).toEqual([]);
		expect(normalizeTaskList({ items: [] })).toEqual([]);
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
