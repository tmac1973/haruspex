import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, ToolExecOutput, ToolRegistration } from './types';

// prepareSlides in fs-write.ts: shape forgiveness (JSON strings, string
// bullets, layout case) and the scaffold checks (no title, placeholder
// bullets). The executors are captured at registration so the model's raw
// arguments reach them without executeTool's schema coercion. A .pptx is
// built by PptxGenJS (`#lib/slides/pptx.ts`, tested on its own), so here the
// builder only records what it was given.

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	registered: new Map<string, unknown>(),
	built: [] as { slides: unknown[]; orientation: string; theme: string }[],
	/** Set to make the next build throw it. */
	buildError: null as Error | null,
	/** What rendering a preview gives; LibreOffice is "missing" unless a test
	 *  routes `slides_preview_pdf`. */
	sheets: { sheets: ['data:image/jpeg;base64,AAAA'], shown: 3, total: 3 }
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

vi.mock('#lib/agent/pdfRender.ts', () => ({ renderPdfSheets: async () => mocks.sheets }));

vi.mock('#lib/slides/pptx.ts', () => ({
	buildPptx: async (slides: unknown[], orientation: string, _images: unknown, theme: string) => {
		if (mocks.buildError) throw mocks.buildError;
		mocks.built.push({ slides, orientation, theme });
		return new Uint8Array([0x50, 0x4b, 3, 4]);
	}
}));

vi.mock('#lib/slides/images.ts', () => ({ loadSlideImages: async () => new Map() }));

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
import { makeToolContext } from '#lib/testing/toolContext.ts';

let ctx: ToolContext;
let sent: { command: string; payload: Record<string, unknown> }[];

beforeEach(() => {
	ctx = makeToolContext({ workingDir: '/tmp/work' });
	sent = [];
	mocks.built.length = 0;
	const write = (command: string) => (payload?: Record<string, unknown>) => {
		sent.push({ command, payload: payload! });
		return undefined;
	};
	mocks.invoke.mockReset().mockImplementation(
		invokeRouter(
			{
				fs_path_exists: false,
				fs_write_pptx: write('fs_write_pptx'),
				fs_write_odp: write('fs_write_odp'),
				slides_preview_pdf: () => {
					throw new Error('LibreOffice is not installed.');
				}
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
	return executor('fs_write_slides')({ path: 'd.pptx', slides }, ctx);
}

function errorOf(out: ToolExecOutput): string {
	return (JSON.parse(out.result) as { error: string }).error;
}

/** The slides that reached the writer: the deck builder for .pptx, the Rust
 *  command for .odp. */
function sentSlides(): Record<string, unknown>[] {
	expect(sent).toHaveLength(1);
	if (sent[0].command === 'fs_write_pptx') {
		expect(mocks.built).toHaveLength(1);
		return mocks.built[0].slides as Record<string, unknown>[];
	}
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

	it('shifts a list so its shallowest bullet is level 0, keeping its steps', async () => {
		await pptx([
			{
				title: 'T',
				bullets: [
					{ text: 'a', level: 1 },
					{ text: 'b', level: 2 }
				],
				layout: 'two-column',
				right: [{ text: 'c', level: 2 }]
			}
		]);
		expect(sentSlides()[0]).toMatchObject({
			bullets: [
				{ text: 'a', level: 0 },
				{ text: 'b', level: 1 }
			],
			right: [{ text: 'c', level: 0 }]
		});
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

describe('tool-call markup', () => {
	it('refuses it in a bullet, naming the slide', async () => {
		const out = await pptx([
			{ title: 'Fine', bullets: ['a'] },
			{ title: 'Tea', bullets: ['Green tea</parameter> <parameter=slides>'] }
		]);
		expect(errorOf(out)).toMatch(/^Slide 2 contains tool-call markup \("<\/parameter"\)/);
		expect(sent).toHaveLength(0);
	});

	it('refuses it in a title or subtitle', async () => {
		expect(errorOf(await pptx([{ title: '<tool_call>' }]))).toMatch(/^Slide 1 contains/);
		const sub = await pptx([{ title: 'T', subtitle: 'x </function>' }]);
		expect(errorOf(sub)).toMatch(/^Slide 1 contains/);
	});

	it('finds it in a nested bullet', async () => {
		const out = await pptx([{ title: 'T', bullets: [{ text: '</fs_write_slides>', level: 1 }] }]);
		expect(errorOf(out)).toMatch(/tool-call markup/);
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

	it('draws a cover with a picture as an image slide', async () => {
		await pptx([{ title: 'Gorillas', layout: 'cover', subtitle: 'Tag', image: 'g.jpg' }]);
		expect(sentSlides()[0]).toEqual({
			title: 'Gorillas',
			layout: 'image',
			subtitle: 'Tag',
			image: 'g.jpg'
		});
	});

	it('makes a content or two-column slide’s subtitle its first bullet', async () => {
		await pptx([
			{ title: 'A', subtitle: ' From 620 to 1,063 ', bullets: ['x'] },
			{ title: 'B', layout: 'two-column', subtitle: 'Lead', bullets: ['l'], right: ['r'] },
			{
				title: 'C',
				subtitle: 'Beside the chart',
				chart: { type: 'bar', labels: ['a'], series: [{ name: 's', values: [1] }] }
			}
		]);
		const [a, b, c] = sentSlides();
		expect(a).toEqual({ title: 'A', bullets: ['From 620 to 1,063', 'x'] });
		expect(b).toMatchObject({ bullets: ['Lead', 'l'], right: ['r'] });
		expect(b).not.toHaveProperty('subtitle');
		expect(c.bullets).toEqual(['Beside the chart']);
	});

	it('leaves a content slide with only an image as content', async () => {
		await pptx([{ title: 'T', image: 'chart.png' }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', image: 'chart.png' });
	});

	// Rust would read a blank path as the working folder and fail the deck
	// ("Failed to read image : Is a directory"), which Qwen 3.5 9B hit by
	// sending "image": "" on every slide.
	it('drops a blank image, and does not count it as an image', async () => {
		await pptx([
			{ title: 'T', image: '   ' },
			{ title: 'U', image: '', bullets: ['x'] }
		]);
		expect(sentSlides()[0]).toEqual({ title: 'T', layout: 'section' });
		expect(sentSlides()[1]).toEqual({ title: 'U', bullets: ['x'] });
	});

	it('drops a non-string image, and does not count it as an image', async () => {
		await pptx([{ title: 'T', image: { path: 'chart.png' } }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', layout: 'section' });
	});

	// A non-string layout is not normalised, so a slide with bullets sends it
	// to Rust unchanged, where the lowercase enum will not accept it.
	it('drops a non-string layout when the slide has bullets', async () => {
		await pptx([{ title: 'T', layout: 1, bullets: ['x'] }]);
		expect(sentSlides()[0]).not.toHaveProperty('layout');
	});

	it('drops an unknown layout string when the slide has bullets', async () => {
		await pptx([{ title: 'T', layout: 'Timeline', bullets: ['x'] }]);
		expect(sentSlides()[0]).not.toHaveProperty('layout');
	});

	it('replaces an unknown layout with section on a slide with no content', async () => {
		await pptx([{ title: 'T', layout: 'Timeline' }]);
		expect(sentSlides()[0].layout).toBe('section');
	});

	it.each([
		['title', 'cover'],
		['Two-Column', 'two-column'],
		['two_column', 'two-column'],
		['columns', 'two-column'],
		['STAT', 'stat']
	])('reads %s as %s', async (layout, expected) => {
		await pptx([{ title: 'T', layout, bullets: ['a'], right: ['b'] }]);
		expect(sentSlides()[0].layout).toBe(expected);
	});

	it.each(['cover', 'quote', 'stat'])('keeps a %s slide that has no bullets', async (layout) => {
		await pptx([{ title: 'T', layout, subtitle: 'S' }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', layout, subtitle: 'S' });
	});

	it('draws an image slide with no image as content, or as a section when it is empty', async () => {
		await pptx([
			{ title: 'A', layout: 'image', bullets: ['x'] },
			{ title: 'B', layout: 'image', image: ' ' }
		]);
		expect(sentSlides()[0]).toEqual({ title: 'A', bullets: ['x'] });
		expect(sentSlides()[1]).toEqual({ title: 'B', layout: 'section' });
	});

	it('draws a two-column slide with one column as content', async () => {
		await pptx([
			{ title: 'A', layout: 'two-column', bullets: ['x'] },
			{ title: 'B', layout: 'two-column', right: ['y'] }
		]);
		expect(sentSlides()[0]).toEqual({ title: 'A', bullets: ['x'] });
		expect(sentSlides()[1]).toEqual({ title: 'B', bullets: ['y'] });
	});
});

describe('the right column and notes', () => {
	it('splits a string right column on newlines', async () => {
		await pptx([{ title: 'T', layout: 'two-column', bullets: ['a'], right: 'b\n c \n' }]);
		expect(sentSlides()[0].right).toEqual(['b', 'c']);
	});

	it('makes a slide with both columns and no layout two-column', async () => {
		await pptx([{ title: 'T', bullets: ['a'], right: ['b'] }]);
		expect(sentSlides()[0]).toEqual({
			title: 'T',
			layout: 'two-column',
			bullets: ['a'],
			right: ['b']
		});
	});

	it('drops the right column from any other layout', async () => {
		await pptx([{ title: 'T', layout: 'content', bullets: ['a'], right: ['b'] }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', layout: 'content', bullets: ['a'] });
	});

	it('drops a right column that is not a list', async () => {
		await pptx([{ title: 'T', bullets: ['a'], right: 3 }]);
		expect(sentSlides()[0]).not.toHaveProperty('right');
	});

	it('refuses placeholder bullets in the right column', async () => {
		const out = await pptx([
			{ title: 'T', layout: 'two-column', bullets: ['a'], right: ['/data'] }
		]);
		expect(errorOf(out)).toMatch(/placeholder-style bullet/);
	});

	it('refuses tool-call markup in the right column or the notes', async () => {
		const right = await pptx([{ title: 'T', bullets: ['a'], right: ['x </function>'] }]);
		expect(errorOf(right)).toMatch(/^Slide 1 contains tool-call markup/);
		const notes = await pptx([{ title: 'T', bullets: ['a'], notes: '<tool_call>' }]);
		expect(errorOf(notes)).toMatch(/^Slide 1 contains tool-call markup/);
	});

	it('drops blank or non-string notes', async () => {
		await pptx([
			{ title: 'A', bullets: ['a'], notes: '   ' },
			{ title: 'B', bullets: ['b'], notes: 7 },
			{ title: 'C', bullets: ['c'], notes: 'Pause here.' }
		]);
		expect(sentSlides()[0]).not.toHaveProperty('notes');
		expect(sentSlides()[1]).not.toHaveProperty('notes');
		expect(sentSlides()[2].notes).toBe('Pause here.');
	});
});

describe('markdown a model writes into slides', () => {
	it('moves a picture bullet into the image, dropping any after the first', async () => {
		await pptx([
			{ title: 'T', bullets: ['a', '![A gorilla](pics/g.jpg)', '![Another](pics/h.jpg)', 'b'] }
		]);
		expect(sentSlides()[0]).toEqual({ title: 'T', bullets: ['a', 'b'], image: 'pics/g.jpg' });
	});

	it('keeps an image the slide already has', async () => {
		await pptx([{ title: 'T', image: 'own.png', bullets: ['a', '![x](other.png)'] }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', image: 'own.png', bullets: ['a'] });
	});

	it('makes a two-column slide with a picture in a column one list beside the picture', async () => {
		await pptx([
			{
				title: 'T',
				layout: 'two-column',
				bullets: ['a', 'b'],
				right: ['![Family](family.jpg)', 'c']
			}
		]);
		expect(sentSlides()[0]).toEqual({
			title: 'T',
			layout: 'content',
			bullets: ['a', 'b', 'c'],
			image: 'family.jpg'
		});
	});

	it('takes a picture bullet given as {text, level}', async () => {
		await pptx([{ title: 'T', bullets: ['a', { text: '![x](p.png)', level: 1 }] }]);
		expect(sentSlides()[0]).toEqual({ title: 'T', bullets: ['a'], image: 'p.png' });
	});

	it('drops ** from titles, subtitles and table cells, and keeps it in bullets', async () => {
		await pptx([
			{ title: '**Big** news', subtitle: 'a **b**', layout: 'cover' },
			{ title: 'Threats', bullets: ['**Habitat loss** - clearing'] },
			{
				title: 'Data',
				table: [
					['**Year**', 'Event'],
					['1847', '**First**']
				]
			}
		]);
		const [first, second, third] = sentSlides();
		expect(first).toMatchObject({ title: 'Big news', subtitle: 'a b' });
		expect(second.bullets).toEqual(['**Habitat loss** - clearing']);
		expect(third.table).toEqual([
			['Year', 'Event'],
			['1847', 'First']
		]);
	});

	it('drops ** from an .odp deck’s bullets', async () => {
		await executor('fs_write_slides')(
			{
				path: 'd.odp',
				slides: [{ title: 'T', bullets: ['**a** b', { text: 'c **d**', level: 1 }] }]
			},
			ctx
		);
		expect(sentSlides()[0].bullets).toEqual(['a b', { text: 'c d', level: 1 }]);
	});
});

describe('charts and tables', () => {
	const chart = { type: 'bar', labels: ['Q1', 'Q2'], series: [{ name: 'Sales', values: [3, 5] }] };

	it('reaches the builder read, on a content slide whatever the layout said', async () => {
		await pptx([
			{ title: 'T', layout: 'stat', chart: { ...chart, series: [{ values: ['3', '5'] }] } }
		]);
		expect(sentSlides()[0]).toEqual({
			title: 'T',
			layout: 'content',
			chart: { type: 'bar', labels: ['Q1', 'Q2'], series: [{ name: 'Series 1', values: [3, 5] }] }
		});
	});

	it('keeps a slide with only a table as content, not a divider', async () => {
		await pptx([
			{
				title: 'T',
				table: [
					['a', 'b'],
					['1', '2']
				]
			}
		]);
		expect(sentSlides()[0].layout).toBe('content');
	});

	it('refuses a chart it can’t read, naming the slide, and writes nothing', async () => {
		const out = await pptx([
			{ title: 'Fine', bullets: ['a'] },
			{ title: 'T', chart: { labels: ['a', 'b'], values: [1] } }
		]);
		expect(errorOf(out)).toBe(
			`Slide 2's chart can't be drawn: series "Series 1" has 1 values for 2 labels; give one value per label.`
		);
		expect(sent).toHaveLength(0);
	});

	it('refuses tool-call markup in a table cell or a chart label', async () => {
		const table = await pptx([{ title: 'T', table: [['a'], ['x </function>']] }]);
		expect(errorOf(table)).toMatch(/^Slide 1 contains tool-call markup/);
		const labels = await pptx([{ title: 'T', chart: { labels: ['<tool_call>'], values: [1] } }]);
		expect(errorOf(labels)).toMatch(/^Slide 1 contains tool-call markup/);
	});

	it('lists them as bullets in an .odp deck, and says so', async () => {
		const out = await executor('fs_write_slides')(
			{ path: 'd.odp', slides: [{ title: 'T', chart }] },
			ctx
		);
		expect(sent[0].payload.slides).toStrictEqual([
			{ title: 'T', layout: 'content', bullets: ['Q1: 3', 'Q2: 5'] }
		]);
		expect(out.result).toBe(
			'Wrote: d.odp\n.odp is plainer than .pptx: charts were listed as bullets.'
		);
	});
});

describe('theme', () => {
	it.each([
		['dark', 'dark'],
		[' Warm ', 'warm'],
		['neon', 'light'],
		[undefined, 'light'],
		[2, 'light']
	])('reads %j as %s', async (theme, expected) => {
		await executor('fs_write_slides')(
			{ path: 'd.pptx', theme, slides: [{ title: 'T', bullets: ['a'] }] },
			ctx
		);
		expect(mocks.built[0].theme).toBe(expected);
	});
});

describe('a deck whose text will not fit', () => {
	it('is refused with the builder’s list, and nothing is written', async () => {
		mocks.buildError = new Error(
			'The deck was not written: Slide 2 ("X"): the bullets need about 2.0× the room there is.'
		);
		try {
			const out = await pptx([{ title: 'T', bullets: ['a'] }]);
			expect(errorOf(out)).toBe(
				'fs_write_slides failed: The deck was not written: Slide 2 ("X"): the bullets need about 2.0× the room there is.'
			);
			expect(sent).toHaveLength(0);
			expect(ctx.filesWrittenThisTurn.size).toBe(0);
		} finally {
			mocks.buildError = null;
		}
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

describe('an .odp path', () => {
	it('runs the same preparation and writes through its own command', async () => {
		const out = await executor('fs_write_slides')(
			{ path: 'd.odp', slides: '[{"title":"T","bullets":"a\\nb"}]' },
			ctx
		);
		expect(out.result).toBe('Wrote: d.odp');
		expect(sent[0].command).toBe('fs_write_odp');
		expect(sent[0].payload.slides).toEqual([{ title: 'T', bullets: ['a', 'b'] }]);
		expect(sent[0].payload.orientation).toBe('landscape');
		expect(mocks.built).toHaveLength(0);
	});

	it('passes the orientation to Rust', async () => {
		await executor('fs_write_slides')(
			{ path: 'd.odp', orientation: 'portrait', slides: [{ title: 'T', bullets: ['a'] }] },
			ctx
		);
		expect(sent[0].payload.orientation).toBe('portrait');
	});

	it('rejects the same scaffolds', async () => {
		const out = await executor('fs_write_slides')({ path: 'd.odp', slides: [{ title: ' ' }] }, ctx);
		expect(errorOf(out)).toMatch(/^Slide 1 has no title/);
	});

	it('sends layouts it can draw, and says what it simplified', async () => {
		const out = await executor('fs_write_slides')(
			{
				path: 'd.odp',
				theme: 'dark',
				slides: [
					{ title: 'Deck', layout: 'cover', subtitle: 'Q3' },
					{ title: 'T', layout: 'two-column', bullets: ['a'], right: ['b'], notes: 'hi' }
				]
			},
			ctx
		);
		expect(sent[0].payload.slides).toStrictEqual([
			{ title: 'Deck', subtitle: 'Q3', layout: 'section' },
			{ title: 'T', bullets: ['a', 'b'], layout: 'content' }
		]);
		expect(out.result).toBe(
			'Wrote: d.odp\n.odp is plainer than .pptx: cover, two-column slides were drawn as plain ' +
				'title or bullet slides; speaker notes were left out; the theme was not used.'
		);
	});

	it('adds nothing to the result for a deck it drew in full', async () => {
		const out = await executor('fs_write_slides')(
			{ path: 'd.odp', slides: [{ title: 'T', bullets: ['a'] }] },
			ctx
		);
		expect(out.result).toBe('Wrote: d.odp');
	});
});

describe('orientation', () => {
	const slides = [{ title: 'T', bullets: ['a'] }];

	it.each([
		['portrait', 'portrait'],
		[' Portrait ', 'portrait'],
		['vertical', 'portrait'],
		['landscape', 'landscape'],
		['sideways', 'landscape'],
		[undefined, 'landscape'],
		[3, 'landscape']
	])('reads %j as %s', async (orientation, expected) => {
		await executor('fs_write_slides')({ path: 'd.pptx', orientation, slides }, ctx);
		expect(mocks.built[0].orientation).toBe(expected);
	});
});

describe('a .pptx path', () => {
	it('sends the built deck as the raw body, with the path in headers', async () => {
		const calls: unknown[][] = [];
		mocks.invoke.mockImplementation(async (...args: unknown[]) => {
			calls.push(args);
			return args[0] === 'fs_path_exists' ? false : undefined;
		});
		const out = await executor('fs_write_slides')(
			{ path: 'talks/Ünïcode deck.pptx', slides: [{ title: 'T', bullets: ['a'] }] },
			ctx
		);
		expect(out.result).toMatch(/^Wrote: talks\/Ünïcode deck\.pptx/);
		const write = calls.find((c) => c[0] === 'fs_write_pptx')!;
		expect(write[1]).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
		expect(write[2]).toEqual({
			headers: {
				'x-workdir': encodeURIComponent('/tmp/work'),
				'x-rel-path': encodeURIComponent('talks/Ünïcode deck.pptx'),
				'x-overwrite': 'false'
			}
		});
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
		expect(errorOf(out)).toBe('fs_write_slides failed: image not found: chart.png');
		expect(ctx.filesWrittenThisTurn.size).toBe(0);
	});
});

describe('the preview', () => {
	const deck = [
		{ title: 'Intro', bullets: ['a'] },
		{ title: 'Middle', bullets: ['b'] },
		{ title: 'End', bullets: ['c'] }
	];
	let calls: unknown[][];

	/** LibreOffice "installed": every invoke is recorded, and the preview
	 *  command answers with a PDF. */
	beforeEach(() => {
		calls = [];
		mocks.sheets = { sheets: ['data:image/jpeg;base64,AAAA'], shown: 3, total: 3 };
		mocks.invoke.mockImplementation(async (...args: unknown[]) => {
			calls.push(args);
			if (args[0] === 'fs_path_exists') return false;
			if (args[0] === 'slides_preview_pdf') return new ArrayBuffer(4);
			return undefined;
		});
	});

	const previews = () => calls.filter((c) => c[0] === 'slides_preview_pdf');

	it('hands the model the sheets, and says what to look for', async () => {
		mocks.sheets = { sheets: ['data:one', 'data:two'], shown: 18, total: 20 };
		const out = await pptx(deck);
		expect(previews()).toEqual([
			['slides_preview_pdf', { workdir: '/tmp/work', relPath: 'd.pptx' }]
		]);
		expect(ctx.pendingImages).toEqual([
			{ path: 'd.pptx#sheet1', dataUrl: 'data:one' },
			{ path: 'd.pptx#sheet2', dataUrl: 'data:two' }
		]);
		expect(out.result).toMatch(/^Wrote: d\.pptx\nThe sheets show slides 1–18 of 20 as LibreOffice/);
		expect(out.result).toMatch(/write the whole deck again to "d\.pptx"/);
	});

	it('previews an .odp deck too', async () => {
		await executor('fs_write_slides')({ path: 'd.odp', slides: deck }, ctx);
		expect(previews()).toEqual([
			['slides_preview_pdf', { workdir: '/tmp/work', relPath: 'd.odp' }]
		]);
	});

	it('is skipped for a model that can’t see images', async () => {
		ctx.visionSupported = false;
		const out = await pptx(deck);
		expect(out.result).toBe('Wrote: d.pptx');
		expect(previews()).toEqual([]);
	});

	it('is skipped while other images wait for the model', async () => {
		ctx.pendingImages.push({ path: 'x.png', dataUrl: 'data:x' });
		const out = await pptx(deck);
		expect(out.result).toBe('Wrote: d.pptx');
		expect(previews()).toEqual([]);
	});

	it('leaves the result alone without LibreOffice', async () => {
		mocks.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === 'slides_preview_pdf') throw new Error('LibreOffice is not installed.');
			return cmd === 'fs_path_exists' ? false : undefined;
		});
		const out = await pptx(deck);
		expect(out.result).toBe('Wrote: d.pptx');
		expect(ctx.pendingImages).toEqual([]);
	});

	it('is of the file the user chose to keep beside the old one', async () => {
		mocks.invoke.mockImplementation(async (...args: unknown[]) => {
			calls.push(args);
			if (args[0] === 'fs_path_exists') return true;
			if (args[0] === 'fs_find_available_path') return 'd-1.pptx';
			if (args[0] === 'slides_preview_pdf') return new ArrayBuffer(4);
			return undefined;
		});
		const conflict = await import('#lib/stores/fileConflict.svelte.ts');
		const ask = vi.spyOn(conflict, 'askFileConflict').mockResolvedValue('counter');
		try {
			await pptx(deck);
		} finally {
			ask.mockRestore();
		}
		expect(previews()[0][1]).toEqual({ workdir: '/tmp/work', relPath: 'd-1.pptx' });
	});
});

describe('writing a previewed deck again', () => {
	const deck = [
		{ title: 'Intro', bullets: ['a'] },
		{ title: 'Middle', bullets: ['b'] },
		{ title: 'End', bullets: ['c'] }
	];
	let calls: unknown[][];

	// The file doesn't exist before the first write; a rewrite never asks, so
	// what fs_path_exists says after doesn't matter.
	beforeEach(() => {
		calls = [];
		mocks.invoke.mockImplementation(async (...args: unknown[]) => {
			calls.push(args);
			if (args[0] === 'fs_path_exists') return false;
			if (args[0] === 'slides_preview_pdf') return new ArrayBuffer(4);
			return undefined;
		});
	});

	const writes = () => calls.filter((c) => c[0] === 'fs_write_pptx');
	/** A new turn's write set, as each turn gets. */
	const freshTurn = () => {
		ctx.filesWrittenThisTurn = new Set();
		ctx.pendingImages.length = 0;
	};

	it('is allowed twice, replacing the file without asking', async () => {
		freshTurn();
		const first = await pptx(deck);
		expect(first.result).toMatch(/^Wrote: d\.pptx/);
		// The model looks, then fixes a slide and writes the whole deck again.
		ctx.pendingImages.length = 0;
		const fixed = deck.map((s, i) => (i === 1 ? { ...s, bullets: ['b, shorter'] } : s));
		const second = await pptx(fixed);
		expect(second.result).toMatch(/^Wrote: d\.pptx/);
		ctx.pendingImages.length = 0;
		const third = await pptx(fixed);
		expect(third.result).toMatch(/^Wrote: d\.pptx/);
		expect(third.result).toMatch(/rewritten as many times as it can be this turn/);
		ctx.pendingImages.length = 0;
		const fourth = await pptx(fixed);
		expect(errorOf(fourth)).toMatch(/was already written in this turn/);
		expect(writes()).toHaveLength(3);
		// Replacing its own file never asks: the header says overwrite.
		for (const w of writes().slice(1)) {
			expect((w[2] as { headers: Record<string, string> }).headers['x-overwrite']).toBe('true');
		}
	});

	it('keeps the deck’s theme and orientation when the rewrite leaves them out', async () => {
		freshTurn();
		const write = executor('fs_write_slides');
		await write({ path: 'd.pptx', slides: deck, theme: 'dark', orientation: 'portrait' }, ctx);
		ctx.pendingImages.length = 0;
		const out = await write({ path: 'd.pptx', slides: deck }, ctx);
		expect(out.result).toMatch(/^Wrote: d\.pptx/);
		expect(mocks.built.map((b) => [b.theme, b.orientation])).toEqual([
			['dark', 'portrait'],
			['dark', 'portrait']
		]);
		// A rewrite that names a theme gets it.
		ctx.pendingImages.length = 0;
		await write({ path: 'd.pptx', slides: deck, theme: 'warm' }, ctx);
		expect(mocks.built[2]).toMatchObject({ theme: 'warm', orientation: 'portrait' });
	});

	it('is refused when most of the slides are new: a second piece of a deck', async () => {
		freshTurn();
		await pptx(deck);
		ctx.pendingImages.length = 0;
		const out = await pptx([
			{ title: 'Part two', bullets: ['x'] },
			{ title: 'More', bullets: ['y'] },
			{ title: 'End', bullets: ['z'] }
		]);
		expect(errorOf(out)).toMatch(/was already written in this turn/);
		expect(writes()).toHaveLength(1);
	});

	it('is allowed for a deck the turn created, without a preview', async () => {
		freshTurn();
		ctx.visionSupported = false;
		await pptx(deck);
		const out = await pptx(deck.map((s, i) => (i === 2 ? { ...s, title: 'Questions' } : s)));
		expect(out.result).toMatch(/^Wrote: d\.pptx/);
		expect(writes()).toHaveLength(2);
	});

	it('is refused for a deck the model wasn’t shown that was there before the turn', async () => {
		freshTurn();
		ctx.visionSupported = false;
		ctx.codeSessionId = 'sess-1';
		mocks.invoke.mockImplementation(async (...args: unknown[]) => {
			calls.push(args);
			return args[0] === 'fs_path_exists' ? true : undefined;
		});
		await pptx(deck);
		const out = await pptx(deck);
		expect(errorOf(out)).toMatch(/was already written in this turn/);
		expect(errorOf(out)).not.toMatch(/keeping most of its slide titles/);
	});

	it('refuses a created deck that keeps too few of its slides, saying how to revise it', async () => {
		freshTurn();
		ctx.visionSupported = false;
		await pptx(deck);
		const out = await pptx([{ title: 'Part two', bullets: ['d'] }]);
		expect(errorOf(out)).toMatch(/was already written in this turn/);
		expect(errorOf(out)).toMatch(/keeping most of its slide titles/);
	});
});
