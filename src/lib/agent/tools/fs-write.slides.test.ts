import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, ToolExecOutput, ToolRegistration } from './types';

// prepareSlides in fs-write.ts: shape forgiveness (JSON strings, string
// bullets, layout case) and the scaffold checks (no title, placeholder
// bullets). The executors are captured at registration so the model's raw
// arguments reach them without executeTool's schema coercion.

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	registered: new Map<string, unknown>()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

vi.mock('./registry', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./registry')>();
	return {
		...actual,
		registerTool: (reg: ToolRegistration) => {
			mocks.registered.set(reg.schema.function.name, reg);
			actual.registerTool(reg);
		}
	};
});

import './fs-write';
import { invokeRouter, unexpectedInvoke } from '#lib/testing/invoke.ts';

let ctx: ToolContext;
let sent: { command: string; payload: Record<string, unknown> }[];

beforeEach(() => {
	ctx = {
		workingDir: '/tmp/work',
		pendingImages: [],
		deepResearch: false,
		shellMode: false,
		codeMode: false,
		codeAutoApprove: false,
		filesWrittenThisTurn: new Set<string>()
	} as ToolContext;
	sent = [];
	const write = (command: string) => (payload?: Record<string, unknown>) => {
		sent.push({ command, payload: payload! });
		return undefined;
	};
	mocks.invoke.mockReset().mockImplementation(
		invokeRouter(
			{
				fs_path_exists: false,
				fs_write_pptx: write('fs_write_pptx'),
				fs_write_odp: write('fs_write_odp')
			},
			unexpectedInvoke
		)
	);
});

function executor(name: string) {
	const reg = mocks.registered.get(name) as ToolRegistration | undefined;
	if (!reg) throw new Error(`${name} was not registered`);
	return reg.execute;
}

function pptx(slides: unknown): Promise<ToolExecOutput> {
	return executor('fs_write_pptx')({ path: 'd.pptx', slides }, ctx);
}

function errorOf(out: ToolExecOutput): string {
	return (JSON.parse(out.result) as { error: string }).error;
}

function sentSlides(): Record<string, unknown>[] {
	expect(sent).toHaveLength(1);
	return sent[0].payload.slides as Record<string, unknown>[];
}

describe('slides that are not an array', () => {
	it.each([
		['undefined', undefined],
		['null', null],
		['a number', 3],
		['a bare slide object', { title: 'Hello', bullets: ['a'] }],
		['plain text', 'Slide 1: Intro'],
		['a JSON object string', '{"title":"Intro"}'],
		['malformed JSON', '[{"title":"Intro"'],
		['an empty array', []],
		['an empty JSON array string', '[]']
	])('rejects %s', async (_label, slides) => {
		const out = await pptx(slides);
		expect(errorOf(out)).toBe(
			'slides must be a non-empty array. Pass every slide you want in the deck.'
		);
		expect(sent).toHaveLength(0);
	});

	it('parses a JSON array string', async () => {
		const out = await pptx(' [{"title":"Intro","bullets":["One"]}] ');
		expect(out.result).toBe('Wrote: d.pptx');
		expect(sentSlides()).toEqual([{ title: 'Intro', bullets: ['One'] }]);
	});
});

describe('malformed slide entries', () => {
	it.each([
		['null', null],
		['a string', 'Intro'],
		['a number', 1],
		['false', false]
	])('rejects a slide that is %s', async (_label, slide) => {
		const out = await pptx([{ title: 'Ok', bullets: ['x'] }, slide]);
		expect(errorOf(out)).toBe('Slide 2 is not an object. Each slide needs at least a title.');
	});

	it('reports an array slide as missing its title', async () => {
		expect(errorOf(await pptx([['Intro', 'One']]))).toMatch(/^Slide 1 has no title/);
	});

	it.each([
		['missing', {}],
		['empty', { title: '' }],
		['whitespace', { title: '  \n ' }],
		['a number', { title: 42, bullets: ['x'] }],
		['an array', { title: ['Intro'], bullets: ['x'] }]
	])('rejects a title that is %s', async (_label, slide) => {
		expect(errorOf(await pptx([slide]))).toBe(
			'Slide 1 has no title. Every slide must have a non-empty title string.'
		);
	});

	it('names the first bad slide by position', async () => {
		const out = await pptx([{ title: 'A' }, { title: 'B' }, { title: '' }, { title: '' }]);
		expect(errorOf(out)).toMatch(/^Slide 3 has no title/);
	});
});

describe('bullets', () => {
	it('splits a string on newlines, trimming and dropping blank lines', async () => {
		await pptx([{ title: 'T', bullets: '  First \r\n\n Second\n   \nThird' }]);
		expect(sentSlides()[0].bullets).toEqual(['First', 'Second', 'Third']);
	});

	it('turns a blank bullets string into a section divider with no bullets', async () => {
		await pptx([{ title: 'T', bullets: '  \n ' }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', bullets: [], layout: 'section' });
	});

	it('keeps {text, level} objects as they are', async () => {
		const bullets = [{ text: 'Top', level: 0 }, { text: 'Sub', level: 1 }, 'Plain'];
		await pptx([{ title: 'T', bullets }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', bullets });
	});

	it('treats bullets with no usable text as no bullets', async () => {
		await pptx([{ title: 'T', bullets: [{ text: 5 }, { level: 1 }, null, 7, '   '] }]);
		expect(sentSlides()[0].layout).toBe('section');
	});

	it('treats a non-array, non-string bullets value as no bullets', async () => {
		await pptx([{ title: 'T', bullets: { text: 'One' } }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', bullets: { text: 'One' }, layout: 'section' });
	});
});

describe('placeholder bullets', () => {
	it.each([
		['a string', ['/content']],
		['a padded string', ['  /data  ']],
		['an object', [{ text: '/BULLETS', level: 1 }]]
	])('rejects %s', async (_label, bullets) => {
		const out = await pptx([{ title: 'T', bullets }]);
		expect(errorOf(out)).toMatch(/^Slide 1 contains a placeholder-style bullet/);
		expect(sent).toHaveLength(0);
	});

	it('rejects placeholders that arrive in a newline-separated string', async () => {
		const out = await pptx([{ title: 'T', bullets: '/fill_in\n/more' }]);
		expect(errorOf(out)).toMatch(/placeholder-style bullet/);
	});

	it('accepts a slash command among real bullets', async () => {
		const out = await pptx([{ title: 'T', bullets: ['Type a slash to see commands', '/help'] }]);
		expect(out.result).toBe('Wrote: d.pptx');
		expect(sentSlides()[0].bullets).toEqual(['Type a slash to see commands', '/help']);
	});

	it('rejects one on a section slide too', async () => {
		const out = await pptx([{ title: 'T', layout: 'section', bullets: ['/content'] }]);
		expect(errorOf(out)).toMatch(/placeholder-style bullet/);
	});

	// Still ambiguous: a slide of nothing but /words looks exactly like a
	// scaffold. The error asks for literal text, so "/help — list commands"
	// goes through.
	it('still rejects a slide whose only bullets are slash commands', async () => {
		const out = await pptx([{ title: 'Commands', bullets: ['/help', '/clear'] }]);
		expect(errorOf(out)).toMatch(/placeholder-style bullet/);
	});

	it.each([['/usr/bin'], ['/v2'], ['and/or'], ['/ spaced']])('accepts %j', async (bullet) => {
		const out = await pptx([{ title: 'T', bullets: [bullet] }]);
		expect(out.result).toBe('Wrote: d.pptx');
	});
});

describe('layout', () => {
	it('lowercases and trims a string layout', async () => {
		await pptx([{ title: 'T', layout: '  CONTENT ', bullets: ['x'] }]);
		expect(sentSlides()[0].layout).toBe('content');
	});

	it('keeps an explicit section layout with bullets', async () => {
		await pptx([{ title: 'T', layout: 'Section', bullets: ['x'] }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', layout: 'section', bullets: ['x'] });
	});

	it('makes a title-only slide a section divider, keeping its subtitle', async () => {
		await pptx([{ title: 'Part 2', subtitle: 'Results' }]);
		expect(sentSlides()[0]).toEqual({ title: 'Part 2', subtitle: 'Results', layout: 'section' });
	});

	it('leaves a content slide with only an image as content', async () => {
		await pptx([{ title: 'T', image: 'chart.png' }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', image: 'chart.png' });
	});

	it('does not count a blank image as an image', async () => {
		await pptx([{ title: 'T', image: '   ' }]);
		expect(sentSlides()[0].layout).toBe('section');
	});

	it('does not count a non-string image as an image', async () => {
		await pptx([{ title: 'T', image: { path: 'chart.png' } }]);
		expect(sentSlides()[0].layout).toBe('section');
	});

	// A non-string layout is not normalised, so a slide with bullets sends it
	// to Rust unchanged, where the lowercase enum will not accept it.
	it('drops a non-string layout when the slide has bullets', async () => {
		await pptx([{ title: 'T', layout: 1, bullets: ['x'] }]);
		expect(sentSlides()[0]).not.toHaveProperty('layout');
	});

	it('drops an unknown layout string when the slide has bullets', async () => {
		await pptx([{ title: 'T', layout: 'Two-Column', bullets: ['x'] }]);
		expect(sentSlides()[0]).not.toHaveProperty('layout');
	});

	it('replaces an unknown layout with section on a slide with no content', async () => {
		await pptx([{ title: 'T', layout: 'Two-Column' }]);
		expect(sentSlides()[0].layout).toBe('section');
	});
});

describe('the input is left alone', () => {
	it('does not mutate the slides the model sent', async () => {
		const slides = [{ title: 'T', layout: 'CONTENT', bullets: 'a\nb' }, { title: 'Divider' }];
		const before = structuredClone(slides);
		await pptx(slides);
		expect(slides).toEqual(before);
		expect(sentSlides()).toEqual([
			{ title: 'T', layout: 'content', bullets: ['a', 'b'] },
			{ title: 'Divider', layout: 'section' }
		]);
	});
});

describe('fs_write_odp', () => {
	it('runs the same preparation and writes through its own command', async () => {
		const out = await executor('fs_write_odp')(
			{ path: 'd.odp', slides: '[{"title":"T","bullets":"a\\nb"}]' },
			ctx
		);
		expect(out.result).toBe('Wrote: d.odp');
		expect(sent[0].command).toBe('fs_write_odp');
		expect(sent[0].payload.slides).toEqual([{ title: 'T', bullets: ['a', 'b'] }]);
	});

	it('rejects the same scaffolds', async () => {
		const out = await executor('fs_write_odp')({ path: 'd.odp', slides: [{ title: ' ' }] }, ctx);
		expect(errorOf(out)).toMatch(/^Slide 1 has no title/);
	});
});

describe('backend failure', () => {
	it('returns the error and does not count the file as written', async () => {
		mocks.invoke.mockImplementation(
			invokeRouter({ fs_path_exists: false }, () => {
				throw new Error('image not found: chart.png');
			})
		);
		const out = await pptx([{ title: 'T', image: 'chart.png' }]);
		expect(errorOf(out)).toBe('fs_write_pptx failed: image not found: chart.png');
		expect(ctx.filesWrittenThisTurn.size).toBe(0);
	});
});
