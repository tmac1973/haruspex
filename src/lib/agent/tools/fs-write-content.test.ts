import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	logDebug: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

vi.mock('$lib/debug-log', () => ({
	logDebug: mocks.logDebug
}));

const ctx = {
	workingDir: '/tmp/work',
	pendingImages: [],
	deepResearch: false,
	shellMode: false,
	codeMode: false,
	codeAutoApprove: false,
	filesWrittenThisTurn: new Set<string>()
};

beforeEach(() => {
	mocks.invoke.mockReset();
	// Each test is its own turn. Several of them write the same path (d.pptx),
	// and fs-write refuses a repeat write within a turn — so a set carried over
	// between tests would make every case after the first fail.
	ctx.filesWrittenThisTurn.clear();
});

async function call(tool: string, args: unknown) {
	const { executeTool } = await import('$lib/agent/tools');
	return executeTool(tool, args as Record<string, unknown>, ctx);
}

describe('text-content writers reject empty content', () => {
	const tools = ['fs_write_text', 'fs_write_docx', 'fs_write_odt', 'fs_write_pdf'];

	for (const tool of tools) {
		it(`${tool} rejects empty content`, async () => {
			const out = await call(tool, { path: `out.${tool.slice(-3)}`, content: '' });
			expect(JSON.parse(out.result).error).toMatch(/non-empty content/i);
			expect(mocks.invoke).not.toHaveBeenCalled();
		});

		it(`${tool} rejects whitespace-only content`, async () => {
			const out = await call(tool, { path: `out.${tool.slice(-3)}`, content: '   \n\t  ' });
			expect(JSON.parse(out.result).error).toMatch(/non-empty content/i);
			expect(mocks.invoke).not.toHaveBeenCalled();
		});

		it(`${tool} accepts real content and writes`, async () => {
			mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path: `out.${tool.slice(-3)}`,
				content: 'Real content here.'
			});
			expect(out.result).toMatch(/Wrote/);
		});
	}
});

describe('fs_write_pptx / fs_write_odp slide validation', () => {
	const tools = ['fs_write_pptx', 'fs_write_odp'];

	for (const tool of tools) {
		it(`${tool} rejects an empty slides array`, async () => {
			const out = await call(tool, { path: 'd.pptx', slides: [] });
			expect(JSON.parse(out.result).error).toMatch(/non-empty array/i);
			expect(mocks.invoke).not.toHaveBeenCalled();
		});

		it(`${tool} rejects a slide with no title`, async () => {
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{ title: '', bullets: ['a'] }]
			});
			expect(JSON.parse(out.result).error).toMatch(/no title/i);
			expect(mocks.invoke).not.toHaveBeenCalled();
		});

		it(`${tool} treats a title-only slide as a section divider instead of erroring`, async () => {
			mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{ title: 'Topic' }]
			});
			expect(out.result).toMatch(/Wrote/);
			const payload = mocks.invoke.mock.calls.find((c) => c[0] === tool)?.[1] as {
				slides: { layout?: string }[];
			};
			expect(payload.slides[0].layout).toBe('section');
		});

		it(`${tool} treats a title+subtitle slide with no bullets as a section divider`, async () => {
			mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{ title: 'Part One', subtitle: 'the beginning' }]
			});
			expect(out.result).toMatch(/Wrote/);
			const payload = mocks.invoke.mock.calls.find((c) => c[0] === tool)?.[1] as {
				slides: { layout?: string }[];
			};
			expect(payload.slides[0].layout).toBe('section');
		});

		it(`${tool} still rejects a totally empty slide object`, async () => {
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{}]
			});
			expect(JSON.parse(out.result).error).toMatch(/no title/i);
			expect(mocks.invoke).not.toHaveBeenCalled();
		});

		it(`${tool} rejects a placeholder-style bullet`, async () => {
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{ title: 'Topic', bullets: ['/content'] }]
			});
			expect(JSON.parse(out.result).error).toMatch(/placeholder/i);
			expect(mocks.invoke).not.toHaveBeenCalled();
		});

		it(`${tool} allows a section slide without bullets`, async () => {
			mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{ title: 'Part Two', layout: 'section', subtitle: 'a divider' }]
			});
			expect(out.result).toMatch(/Wrote/);
		});

		it(`${tool} lowercases a capitalized layout before sending it to Rust`, async () => {
			mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [
					{ title: 'Part Two', layout: 'Section' },
					{ title: 'Detail', layout: 'CONTENT', bullets: ['a point'] }
				]
			});
			expect(out.result).toMatch(/Wrote/);
			const payload = mocks.invoke.mock.calls.find((c) => c[0] === tool)?.[1] as {
				slides: { layout?: string }[];
			};
			expect(payload.slides[0].layout).toBe('section');
			expect(payload.slides[1].layout).toBe('content');
		});

		it(`${tool} splits string bullets on newlines into an array`, async () => {
			mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{ title: 'Topic', bullets: 'First point\n  Second point  \n\nThird point\n' }]
			});
			expect(out.result).toMatch(/Wrote/);
			const payload = mocks.invoke.mock.calls.find((c) => c[0] === tool)?.[1] as {
				slides: { bullets?: unknown; layout?: string }[];
			};
			expect(payload.slides[0].bullets).toEqual(['First point', 'Second point', 'Third point']);
			expect(payload.slides[0].layout).not.toBe('section');
		});

		it(`${tool} allows a content slide with just an image (no bullets)`, async () => {
			mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{ title: 'Chart', image: 'plot.png' }]
			});
			expect(out.result).toMatch(/Wrote/);
		});

		it(`${tool} accepts a real deck`, async () => {
			mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [
					{ title: 'Intro', bullets: ['Welcome', 'Agenda'] },
					{ title: 'Details', bullets: [{ text: 'Point A', level: 0 }, 'Point B'] }
				]
			});
			expect(out.result).toMatch(/Wrote/);
		});
	}
});
