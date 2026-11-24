import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotebookCard } from '#lib/notebooks/api.ts';

const py = vi.hoisted(() => ({ runPython: vi.fn() }));
vi.mock('#lib/sandbox/sandbox.ts', () => py);
vi.mock('#lib/sandbox/availability.ts', () => ({ pythonRuntimeMissing: () => false }));
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => ({ sandboxEnabled: true, sandboxTimeoutSeconds: 60 })
}));
vi.mock('#lib/notebooks/api.ts', async (orig) => ({
	...(await orig<typeof import('#lib/notebooks/api.ts')>()),
	getRows: vi.fn()
}));

import { isStale, keepArtifacts, prelude, runPythonCard, tableSpecs } from './pythonRun';

function card(over: Partial<NotebookCard>): NotebookCard {
	return {
		id: 'c',
		notebook_id: 'n1',
		position: 1,
		kind: 'table',
		title: 'Speakers',
		body: '',
		meta: JSON.stringify({
			columns: [
				{ id: 'name', name: 'Name', type: 'text' },
				{ id: 'price', name: 'Price', type: 'currency' }
			]
		}),
		version: 2,
		source: '{"kind":"user"}',
		created_at: 0,
		updated_at: 0,
		deleted_at: null,
		row_count: 1,
		rows: [{ id: 'r1', position: 1, cells: '{"name":"JBL","price":129}' }],
		...over
	};
}

const ok = (over: Record<string, unknown> = {}) => ({
	stdout: '',
	stderr: '',
	result: '',
	error: null,
	artifacts: 0,
	artifactsList: [],
	notes: [],
	duration_ms: 5,
	...over
});

describe('python cards', () => {
	beforeEach(() => {
		py.runPython.mockReset();
	});

	it('names tables by title, numbering repeats', async () => {
		const specs = await tableSpecs([
			card({ id: 'a' }),
			card({ id: 'b' }),
			card({ id: 'p', kind: 'python' })
		]);
		expect(specs.map((s) => s.name)).toEqual(['Speakers', 'Speakers (2)']);
		expect(specs[0].rows).toEqual([{ name: 'JBL', price: 129 }]);
	});

	it('hands the tables over as a JSON string literal', async () => {
		const code = prelude(await tableSpecs([card({ title: 'Say "hi"\n' })]));
		const literal = /_nb_json\.loads\((.*)\)\)/.exec(code)?.[1] ?? '';
		expect(JSON.parse(JSON.parse(literal))[0].name).toBe('Say "hi"');
		expect(code).toContain('pd.to_numeric');
	});

	it('runs setup, the code, then reads a DataFrame result as CSV', async () => {
		py.runPython
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok({ stdout: 'hello\n' }))
			.mockResolvedValueOnce(ok({ stdout: 'Name,Price\nJBL,129\n' }));
		const t = card({ id: 't' });
		const out = await runPythonCard(card({ id: 'p', kind: 'python', body: 'print("hello")' }), [t]);
		expect(py.runPython.mock.calls.map((c) => c[0])).toEqual([
			'notebook-n1',
			'notebook-n1',
			'notebook-n1'
		]);
		expect(py.runPython.mock.calls[1][1]).toBe('print("hello")');
		expect(out.stdout).toBe('hello\n');
		expect(out.result_csv).toBe('Name,Price\nJBL,129\n');
		expect(out.read_versions).toEqual({ t: 2 });
	});

	it('is stale once a table it read changes', () => {
		const out = { read_versions: { t: 2 } } as unknown as Parameters<typeof isStale>[0];
		expect(isStale(out, [card({ id: 't', version: 2 })])).toBe(false);
		expect(isStale(out, [card({ id: 't', version: 3 })])).toBe(true);
	});

	it('leaves out pictures over 2 MB', () => {
		const big = { kind: 'image' as const, mime: 'image/png', dataUrl: 'x'.repeat(3 * 1024 * 1024) };
		const small = { kind: 'image' as const, mime: 'image/png', dataUrl: 'x' };
		const { kept, notes } = keepArtifacts([big, small]);
		expect(kept).toEqual([small]);
		expect(notes[0]).toMatch(/2 MB/);
	});
});
