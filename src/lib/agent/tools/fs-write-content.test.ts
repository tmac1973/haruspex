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
	shellAllowWrite: false,
	filesWrittenThisTurn: new Set<string>()
};

beforeEach(() => {
	mocks.invoke.mockReset();
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

		it(`${tool} rejects a content slide with no bullets and no image`, async () => {
			const out = await call(tool, {
				path: 'd.pptx',
				slides: [{ title: 'Topic' }]
			});
			expect(JSON.parse(out.result).error).toMatch(/no bullets and no image/i);
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
