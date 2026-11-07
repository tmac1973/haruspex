import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { pngHeader } from '#lib/slides/testImages.ts';

const mocks = vi.hoisted(() => ({
	logDebug: vi.fn()
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal, {
		logDebug: mocks.logDebug
	})
);

const ctx = makeToolContext({
	workingDir: '/tmp/work'
});

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	// Each test is its own turn. Several of them write the same path (d.pptx),
	// and fs-write refuses a repeat write within a turn — so a set carried over
	// between tests would make every case after the first fail.
	ctx.filesWrittenThisTurn.clear();
});

async function call(tool: string, args: unknown) {
	const { executeTool } = await import('#lib/agent/tools/index.ts');
	return executeTool(tool, args as Record<string, unknown>, ctx);
}

describe('text-content writers reject empty content', () => {
	const writes = [
		['fs_write_text', 'out.txt'],
		['fs_write_document', 'out.docx'],
		['fs_write_document', 'out.odt'],
		['fs_write_document', 'out.pdf']
	];

	for (const [tool, path] of writes) {
		it(`${tool} ${path} rejects empty content`, async () => {
			const out = await call(tool, { path, content: '' });
			expect(JSON.parse(out.result).error).toMatch(/non-empty content/i);
			expect(invoke).not.toHaveBeenCalled();
		});

		it(`${tool} ${path} rejects whitespace-only content`, async () => {
			const out = await call(tool, { path, content: '   \n\t  ' });
			expect(JSON.parse(out.result).error).toMatch(/non-empty content/i);
			expect(invoke).not.toHaveBeenCalled();
		});

		it(`${tool} ${path} accepts real content and writes`, async () => {
			vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path,
				content: 'Real content here.'
			});
			expect(out.result).toMatch(/Wrote/);
		});
	}
});

describe('fs_write_slides slide validation', () => {
	const decks = [
		['d.pptx', 'fs_write_pptx'],
		['d.odp', 'fs_write_odp']
	];

	// A .pptx is built here and reads its pictures before the path check, so
	// answer by command rather than by call order.
	beforeEach(() => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter(
				{ fs_path_exists: false, fs_read_bytes: Array.from(pngHeader(40, 30)) },
				undefined
			)
		);
	});

	/** The slides Rust was sent. Only .odp sends them: a .pptx goes as the
	 *  built deck, and fs-write.slides.test.ts checks what reaches its builder. */
	function odpSlides(): { layout?: string; bullets?: unknown }[] {
		const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'fs_write_odp');
		return (call![1] as { slides: { layout?: string; bullets?: unknown }[] }).slides;
	}

	it('d.pptx sends a built PowerPoint package with its image', async () => {
		const out = await call('fs_write_slides', {
			path: 'd.pptx',
			orientation: 'portrait',
			slides: [{ title: 'Chart', bullets: ['a point'], image: 'plot.png' }]
		});
		expect(out.result).toBe('Wrote: d.pptx');
		const write = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'fs_write_pptx')!;
		const deck = write[1] as Uint8Array;
		expect(Array.from(deck.subarray(0, 4))).toEqual([0x50, 0x4b, 3, 4]);
		expect(invoke).toHaveBeenCalledWith('fs_read_bytes', {
			workdir: '/tmp/work',
			relPath: 'plot.png'
		});
	});

	for (const [path, command] of decks) {
		const sendsSlides = command === 'fs_write_odp';
		it(`${path} rejects an empty slides array`, async () => {
			const out = await call('fs_write_slides', { path, slides: [] });
			expect(JSON.parse(out.result).error).toMatch(/non-empty array/i);
			expect(invoke).not.toHaveBeenCalled();
		});

		it(`${path} rejects a slide with no title`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [{ title: '', bullets: ['a'] }]
			});
			expect(JSON.parse(out.result).error).toMatch(/no title/i);
			expect(invoke).not.toHaveBeenCalled();
		});

		it(`${path} treats a title-only slide as a section divider instead of erroring`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [{ title: 'Topic' }]
			});
			expect(out.result).toMatch(/Wrote/);
			if (sendsSlides) expect(odpSlides()[0].layout).toBe('section');
		});

		it(`${path} treats a title+subtitle slide with no bullets as a section divider`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [{ title: 'Part One', subtitle: 'the beginning' }]
			});
			expect(out.result).toMatch(/Wrote/);
			if (sendsSlides) expect(odpSlides()[0].layout).toBe('section');
		});

		it(`${path} still rejects a totally empty slide object`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [{}]
			});
			expect(JSON.parse(out.result).error).toMatch(/no title/i);
			expect(invoke).not.toHaveBeenCalled();
		});

		it(`${path} rejects a placeholder-style bullet`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [{ title: 'Topic', bullets: ['/content'] }]
			});
			expect(JSON.parse(out.result).error).toMatch(/placeholder/i);
			expect(invoke).not.toHaveBeenCalled();
		});

		it(`${path} allows a section slide without bullets`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [{ title: 'Part Two', layout: 'section', subtitle: 'a divider' }]
			});
			expect(out.result).toMatch(/Wrote/);
		});

		it(`${path} lowercases a capitalized layout before sending it to Rust`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [
					{ title: 'Part Two', layout: 'Section' },
					{ title: 'Detail', layout: 'CONTENT', bullets: ['a point'] }
				]
			});
			expect(out.result).toMatch(/Wrote/);
			if (sendsSlides) {
				expect(odpSlides()[0].layout).toBe('section');
				expect(odpSlides()[1].layout).toBe('content');
			}
		});

		it(`${path} splits string bullets on newlines into an array`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [{ title: 'Topic', bullets: 'First point\n  Second point  \n\nThird point\n' }]
			});
			expect(out.result).toMatch(/Wrote/);
			if (sendsSlides) {
				expect(odpSlides()[0].bullets).toEqual(['First point', 'Second point', 'Third point']);
				expect(odpSlides()[0].layout).not.toBe('section');
			}
		});

		it(`${path} allows a content slide with just an image (no bullets)`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [{ title: 'Chart', image: 'plot.png' }]
			});
			expect(out.result).toMatch(/Wrote/);
		});

		it(`${path} accepts a real deck`, async () => {
			const out = await call('fs_write_slides', {
				path,
				slides: [
					{ title: 'Intro', bullets: ['Welcome', 'Agenda'] },
					{ title: 'Details', bullets: [{ text: 'Point A', level: 0 }, 'Point B'] }
				]
			});
			expect(out.result).toMatch(/Wrote/);
		});
	}
});

describe('the merged writers pick the format from the extension', () => {
	const written = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] !== 'fs_path_exists');

	it('routes each document extension to its command, in any case', async () => {
		for (const [path, command] of [
			['a.docx', 'fs_write_docx'],
			['b.ODT', 'fs_write_odt'],
			['c.Pdf', 'fs_write_pdf']
		]) {
			vi.mocked(invoke).mockReset();
			vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call('fs_write_document', { path, content: 'Body.' });
			expect(out.result).toBe(`Wrote: ${path}`);
			expect(written()[0][0]).toBe(command);
		}
	});

	it('refuses an extension the tool does not write, and names the tool that does', async () => {
		const out = await call('fs_write_document', { path: 'notes.md', content: 'Body.' });
		expect(JSON.parse(out.result).error).toBe(
			'fs_write_document writes .docx, .odt, .pdf files: end the path with one of those. ' +
				'For .md or .txt use fs_write_text.'
		);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('refuses a path with no extension', async () => {
		const out = await call('fs_write_spreadsheet', {
			path: 'data',
			sheets: [{ name: 'S', rows: [['a'], ['1']] }]
		});
		expect(JSON.parse(out.result).error).toMatch(/^fs_write_spreadsheet writes \.xlsx, \.ods/);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('does not take a dot in a folder name for an extension', async () => {
		const out = await call('fs_write_slides', { path: 'v1.pptx/deck', slides: [{ title: 'T' }] });
		expect(JSON.parse(out.result).error).toMatch(/^fs_write_slides writes/);
	});
});

describe('the retired per-format tools still work', () => {
	it('routes fs_write_pdf to fs_write_document as a PDF, adding the extension', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
		const out = await call('fs_write_pdf', { path: 'report', content: 'Body.' });
		expect(out.result).toBe('Wrote: report.pdf');
		expect(invoke).toHaveBeenLastCalledWith(
			'fs_write_pdf',
			expect.objectContaining({ relPath: 'report.pdf' })
		);
	});

	it('keeps a path that already has the extension', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
		const out = await call('fs_write_odp', { path: 'deck.ODP', slides: [{ title: 'T' }] });
		expect(out.result).toBe('Wrote: deck.ODP');
		expect(invoke).toHaveBeenCalledWith('fs_write_odp', expect.any(Object));
	});

	it('labels a retired call as its replacement does, and never offers it', async () => {
		const { getDisplayLabel, getToolSchemas } = await import('#lib/agent/tools/index.ts');
		expect(getDisplayLabel('fs_write_xlsx', { path: 'a' })).toBe('a.xlsx');
		const offered = getToolSchemas({ hasWorkingDir: true }).map((s) => s.function.name);
		expect(offered).not.toContain('fs_write_xlsx');
		expect(offered).toEqual(
			expect.arrayContaining(['fs_write_document', 'fs_write_spreadsheet', 'fs_write_slides'])
		);
	});
});

/**
 * `writeRoot` confines a run to one directory. fs_write_text has enforced it
 * since it existed; fs_edit_text never did — harmless only while no writeRoot
 * caller could reach that tool. Guided planning now exposes it (as the escape
 * hatch from the repeat-write guard), so an unguarded edit would have let a
 * "planning only, never edit code" turn rewrite any file in the project.
 */
describe('writeRoot confinement applies to edits, not just writes', () => {
	const rooted = { ...ctx, writeRoot: 'plan/my-feature/' };

	async function callRooted(tool: string, args: Record<string, unknown>) {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		return executeTool(tool, args, rooted);
	}

	it('refuses an edit outside the write root', async () => {
		const out = await callRooted('fs_edit_text', {
			path: 'src/main.rs',
			old_str: 'a',
			new_str: 'b'
		});
		expect(JSON.parse(out.result).error).toMatch(/may only write inside plan\/my-feature\//);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('allows an edit inside the write root', async () => {
		vi.mocked(invoke).mockResolvedValue({ first_changed_line: 12, used_fuzzy: false });
		const out = await callRooted('fs_edit_text', {
			path: 'plan/my-feature/phase-01.md',
			old_str: 'a',
			new_str: 'b'
		});
		expect(out.result).toContain('Edited plan/my-feature/phase-01.md');
		expect(invoke).toHaveBeenCalled();
	});

	it('holds a one-file root to that file, refusing a near-identical name', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const root = 'plan/x/phase-01-pinned-three-js-import-map.md';
		const out = await executeTool(
			'fs_write_text',
			{ path: 'plan/x/phase-01-pinned-three.js-import-map.md', content: '# Phase 01\n' },
			{ ...ctx, writeRoot: root }
		);
		expect(JSON.parse(out.result).error).toBe(
			`This turn may only write ${root}. Refusing to write "plan/x/phase-01-pinned-three.js-import-map.md" — write ${root} instead.`
		);
		expect(invoke).not.toHaveBeenCalled();
	});
});
