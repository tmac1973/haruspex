import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('#lib/agent/tools/_assetIo.ts', () => ({ assetIo: () => ({ read: io.read }) }));
const call = vi.hoisted(() => ({ callSpecialist: vi.fn() }));
vi.mock('#lib/specialists/call.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/specialists/call.ts')>()),
	callSpecialist: call.callSpecialist
}));

import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { askSpecialistLabel } from '#lib/agent/tools/ask-specialist.ts';
import { executeTool } from '#lib/agent/tools/registry.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import { newSpecialistEntry } from '#lib/specialists/entries.ts';
import { registerSpecialistKind, unregisterSpecialistKind } from '#lib/specialists/kinds.ts';
import type { SpecialistEntry, SpecialistRun } from '#lib/specialists/types.ts';
import { getSettings, setSpecialistEntries } from '#lib/stores/settings.ts';

/** A kind that writes and has a mode with no request, like the 3D kinds. */
const runs: SpecialistRun[] = [];
const fake = {
	id: 'fake-writer',
	label: 'Writer',
	summary: '',
	defaultDescription: 'Writes things.',
	defaultSystemPrompt: '',
	defaultSampling: { max_tokens: 100 },
	writes: true,
	params: {
		path: { schema: { type: 'string', description: 'Where.' }, required: false },
		mode: { schema: { type: 'string', description: 'How.' }, required: true }
	},
	requestRequired: false,
	callLabel: (_e: SpecialistEntry, args: Record<string, unknown>) =>
		typeof args.path === 'string' ? `Writer: ${args.path}` : null,
	run: async (run: SpecialistRun) => {
		runs.push(run);
		if (run.request === 'boom') throw new Error('server said no');
		if (run.request === 'stop') throw new DOMException('Aborted', 'AbortError');
		return { result: 'written' };
	}
};

registerSpecialistKind(fake);

function entry(kind: string, name: string, over: Partial<SpecialistEntry> = {}): SpecialistEntry {
	return {
		...newSpecialistEntry(kind, []),
		id: name,
		name,
		url: 'http://s:1',
		model: 'm',
		...over
	};
}

const textOne = entry('text', 'Regex', { onByDefault: true });
const writer = entry('fake-writer', 'Builder', { acceptsImages: true });

const codeTab = { hasWorkingDir: true, codeMode: true, shellMode: false, interactive: true };

function schemaOf(opts: Parameters<typeof getToolSchemas>[0]) {
	return getToolSchemas(opts).find((s) => s.function.name === 'ask_specialist');
}

function props(opts: Parameters<typeof getToolSchemas>[0]) {
	return schemaOf(opts)!.function.parameters as {
		properties: Record<string, Record<string, unknown>>;
		required: string[];
	};
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDir: '/proj',
		codeMode: true,
		codeSpecialists: ['Regex', 'Builder'],
		...over
	} as ToolContext;
}

async function run(args: Record<string, unknown>, c: ToolContext = ctx()) {
	const out = await executeTool('ask_specialist', args, c);
	return out.result;
}

let saved: SpecialistEntry[];

beforeAll(() => {
	saved = getSettings().specialists;
});

afterAll(() => {
	setSpecialistEntries(saved);
	unregisterSpecialistKind('fake-writer');
});

beforeEach(() => {
	setSpecialistEntries([textOne, writer]);
	runs.length = 0;
	call.callSpecialist.mockReset().mockResolvedValue({ content: 'an answer' });
	io.read.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('ask_specialist is offered', () => {
	it('in a Code tab session with a specialist on', () => {
		expect(schemaOf({ ...codeTab, codeSpecialists: ['Builder'] })).toBeDefined();
		// Unset: the ones on by default.
		expect(schemaOf({ ...codeTab, codeSpecialists: null })).toBeDefined();
	});

	it('nowhere else', () => {
		expect(schemaOf({ ...codeTab, codeSpecialists: [] })).toBeUndefined();
		expect(schemaOf({ ...codeTab })).toBeUndefined();
		expect(schemaOf({ hasWorkingDir: true, interactive: true })).toBeUndefined();
		expect(
			schemaOf({ hasWorkingDir: true, codeMode: true, shellMode: true, codeSpecialists: null })
		).toBeUndefined();
		expect(schemaOf({ ...codeTab, codeSpecialists: null, subtask: true })).toBeUndefined();
	});

	it('without write kinds in a read-only session', () => {
		expect(
			schemaOf({ ...codeTab, codeSpecialists: ['Builder'], codeReadOnly: true })
		).toBeUndefined();
		const p = props({ ...codeTab, codeSpecialists: ['Regex', 'Builder'], codeReadOnly: true });
		expect(p.properties.name.enum).toEqual(['Regex']);
		expect(p.properties.path).toBeUndefined();
	});
});

describe("ask_specialist's schema", () => {
	it("names the session's specialists with their descriptions", () => {
		const s = schemaOf({ ...codeTab, codeSpecialists: ['Regex', 'Builder'] })!;
		expect(
			(s.function.parameters as never as { properties: { name: { enum: string[] } } }).properties
				.name.enum
		).toEqual(['Regex', 'Builder']);
		expect(s.function.description).toContain('- Regex: Answers a question');
		expect(s.function.description).toContain('- Builder: Writes things.');
	});

	it("adds a kind's params, marked with the kind, only when it is on", () => {
		const both = props({ ...codeTab, codeSpecialists: ['Regex', 'Builder'] });
		expect(both.properties.path.description).toBe('(Writer only) Where.');
		expect(both.properties.mode).toBeDefined();
		// No kind param is required for every call.
		expect(both.required).toEqual(['name']);
		const text = props({ ...codeTab, codeSpecialists: ['Regex'] });
		expect(text.properties.path).toBeUndefined();
		expect(text.required).toEqual(['name', 'request']);
	});

	it('offers images only for a specialist that accepts them', () => {
		expect(
			props({ ...codeTab, codeSpecialists: ['Builder'] }).properties.images.description
		).toMatch(/^\(only Builder\)/);
		expect(props({ ...codeTab, codeSpecialists: ['Regex'] }).properties.images).toBeUndefined();
	});
});

describe('ask_specialist runs', () => {
	it('the text kind and returns its answer', async () => {
		expect(await run({ name: 'Regex', request: 'ISO dates' })).toBe('an answer');
		expect(call.callSpecialist.mock.calls[0][1]).toBe('ISO dates');
	});

	it("the named kind with the call's fields", async () => {
		expect(await run({ name: 'Builder', mode: 'fast', request: ' a crate ' })).toBe('written');
		expect(runs[0]).toMatchObject({ request: 'a crate', images: [], args: { mode: 'fast' } });
		expect(runs[0].entry.name).toBe('Builder');
	});

	it('with no request for a kind that does not need one', async () => {
		await run({ name: 'Builder', mode: 'fast' });
		expect(runs[0].request).toBeUndefined();
	});

	it('only for a specialist this session has', async () => {
		const c = ctx({ codeSpecialists: ['Regex'] });
		expect(await run({ name: 'Builder', mode: 'x' }, c)).toMatch(
			/No specialist named Builder.*Regex/
		);
	});

	it('refuses fields that are not for the named kind', async () => {
		expect(await run({ name: 'Regex', request: 'x', path: 'a.glb' })).toMatch(
			/path doesn't apply to Regex/
		);
	});

	it("refuses a call missing the kind's required field or request", async () => {
		expect(await run({ name: 'Builder' })).toMatch(/Builder needs mode/);
		expect(await run({ name: 'Regex', request: '  ' })).toMatch(/Regex needs a request/);
	});

	it('refuses a write kind in a read-only session', async () => {
		expect(await run({ name: 'Builder', mode: 'x' }, ctx({ codeReadOnly: true }))).toMatch(
			/read-only/
		);
		expect(runs).toHaveLength(0);
	});

	it("takes the folder's writer lease for a write kind, not for text", async () => {
		const acquire = vi.fn(async () => null);
		const guard = { acquire, changed: vi.fn() };
		await run({ name: 'Regex', request: 'x' }, ctx({ codeWriteGuard: guard }));
		expect(acquire).not.toHaveBeenCalled();
		await run({ name: 'Builder', mode: 'x' }, ctx({ codeWriteGuard: guard }));
		expect(acquire).toHaveBeenCalledOnce();

		acquire.mockResolvedValueOnce('Another session is writing here.' as never);
		expect(await run({ name: 'Builder', mode: 'x' }, ctx({ codeWriteGuard: guard }))).toMatch(
			/Another session is writing/
		);
	});

	it("wraps a kind's error and passes an abort through", async () => {
		expect(await run({ name: 'Builder', mode: 'x', request: 'boom' })).toMatch(
			/Builder failed: server said no/
		);
		await expect(
			executeTool('ask_specialist', { name: 'Builder', mode: 'x', request: 'stop' }, ctx())
		).rejects.toThrow('Aborted');
	});
});

describe("ask_specialist's images", () => {
	it('are read from the folder and sent as data URLs', async () => {
		io.read.mockResolvedValue([1, 2, 3]);
		await run({ name: 'Builder', mode: 'x', images: ['ref/a.png', 'b.JPG'] });
		expect(io.read).toHaveBeenCalledWith('ref/a.png');
		expect(runs[0].images).toEqual([
			{ path: 'ref/a.png', dataUrl: 'data:image/png;base64,AQID' },
			{ path: 'b.JPG', dataUrl: 'data:image/jpeg;base64,AQID' }
		]);
	});

	it('are refused for a specialist that does not take them', async () => {
		expect(await run({ name: 'Regex', request: 'x', images: ['a.png'] })).toMatch(
			/doesn't take images.*Settings → Code → Specialists/
		);
	});

	it('are refused past three, in another format, unreadable or too big', async () => {
		const four = ['a.png', 'b.png', 'c.png', 'd.png'];
		expect(await run({ name: 'Builder', mode: 'x', images: four })).toMatch(/at most 3/);
		expect(await run({ name: 'Builder', mode: 'x', images: ['a.gif'] })).toMatch(
			/PNG, JPEG or WebP/
		);
		io.read.mockRejectedValueOnce('outside the folder');
		expect(await run({ name: 'Builder', mode: 'x', images: ['../a.png'] })).toMatch(
			/Could not read \.\.\/a\.png: outside the folder/
		);
		io.read.mockResolvedValueOnce({ length: 9 * 1024 * 1024 });
		expect(await run({ name: 'Builder', mode: 'x', images: ['big.webp'] })).toMatch(/over 8 MB/);
		expect(runs).toHaveLength(0);
	});
});

describe('a kind added with one module', () => {
	it('adds its fields to the schema only when a specialist of it is on', () => {
		setSpecialistEntries([textOne, entry('glb', 'Assets')]);
		const withGlb = props({ ...codeTab, codeSpecialists: ['Regex', 'Assets'] });
		for (const p of ['path', 'recheck', 'overwrite']) {
			expect(withGlb.properties[p].description).toMatch(/^\(3D asset \(GLB\) only\)/);
		}
		expect(withGlb.required).toEqual(['name']);
		const textOnly = props({ ...codeTab, codeSpecialists: ['Regex'] });
		for (const p of ['path', 'recheck', 'overwrite'])
			expect(textOnly.properties[p]).toBeUndefined();
	});
});

describe("ask_specialist's label", () => {
	it("is the kind's own when it has one, else the name and request", () => {
		expect(askSpecialistLabel({ name: 'Builder', path: 'a.glb' })).toBe('Writer: a.glb');
		expect(askSpecialistLabel({ name: 'Regex', request: 'ISO dates' })).toBe('Regex: ISO dates');
		expect(askSpecialistLabel({ name: 'Regex', request: 'x'.repeat(80) })).toBe(
			`Regex: ${'x'.repeat(59)}…`
		);
	});
});
