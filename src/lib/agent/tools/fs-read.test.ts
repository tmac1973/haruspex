import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './types';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	renderPdfPages: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

vi.mock('#lib/agent/pdfRender.ts', () => ({ renderPdfPages: mocks.renderPdfPages }));

import { IMAGE_EXT_RE, MAX_PENDING_IMAGES } from './fs-read';
import { makeToolContext } from '#lib/testing/toolContext.ts';

let ctx: ToolContext;

beforeEach(() => {
	ctx = makeToolContext({ workingDir: '/tmp/work' });
	mocks.invoke.mockReset();
	mocks.renderPdfPages.mockReset();
});

async function call(tool: string, args: Record<string, unknown>) {
	const { executeTool } = await import('#lib/agent/tools/index.ts');
	return executeTool(tool, args, ctx);
}

function errorOf(out: { result: string }): string {
	return (JSON.parse(out.result) as { error: string }).error;
}

/** Every invoke fails with `e`. */
function invokeRejects(e: unknown) {
	mocks.invoke.mockImplementation(async () => {
		throw e;
	});
}

describe('IMAGE_EXT_RE', () => {
	it.each(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.ico', 'h.tif', 'i.TIFF'])(
		'matches %s',
		(path) => {
			expect(IMAGE_EXT_RE.test(path)).toBe(true);
		}
	);

	it.each(['png', 'a.svg', 'a.png.txt', 'a.jpgx', 'archive.tar', 'a.pngs'])(
		'does not match %s',
		(path) => {
			expect(IMAGE_EXT_RE.test(path)).toBe(false);
		}
	);
});

describe('fs_list_dir', () => {
	it('formats files, directories and sizes', async () => {
		mocks.invoke.mockResolvedValue({
			path: 'src',
			entries: [
				{ name: 'lib', is_dir: true, size: 4096 },
				{ name: 'main.ts', is_dir: false, size: 120 }
			],
			truncated: false
		});
		const out = await call('fs_list_dir', { path: 'src' });
		expect(out.result).toBe('Directory: src\n[DIR] lib\n      main.ts (120 bytes)');
	});

	it('says when a directory is empty', async () => {
		mocks.invoke.mockResolvedValue({ path: 'empty', entries: [], truncated: false });
		expect((await call('fs_list_dir', { path: 'empty' })).result).toBe('Directory: empty\n(empty)');
	});

	it('notes a truncated listing', async () => {
		mocks.invoke.mockResolvedValue({
			path: '.',
			entries: [{ name: 'a', is_dir: false, size: 1 }],
			truncated: true
		});
		expect((await call('fs_list_dir', { path: '.' })).result).toMatch(
			/\.\.\. \(listing truncated; more than 500 entries\)$/
		);
	});

	it('lists the working directory root when no path is given', async () => {
		mocks.invoke.mockImplementation(async (_cmd: string, a: { relPath: string }) => ({
			path: a.relPath,
			entries: [],
			truncated: false
		}));
		expect((await call('fs_list_dir', {})).result).toBe('Directory: .\n(empty)');
	});

	it('returns a tool error when the backend rejects', async () => {
		invokeRejects(new Error('path escapes the working directory'));
		const out = await call('fs_list_dir', { path: '../..' });
		expect(errorOf(out)).toBe('fs_list_dir failed: path escapes the working directory');
	});

	it('returns a tool error in Shell mode too', async () => {
		ctx = { ...ctx, workingDir: null, shellMode: true } as ToolContext;
		invokeRejects('No such file or directory');
		const out = await call('fs_list_dir', { path: '/nope' });
		expect(errorOf(out)).toBe('fs_list_dir failed: No such file or directory');
	});
});

describe('fs_read_text', () => {
	/** Echo the arguments back as the file content, so the result shows them. */
	function echoArgs() {
		mocks.invoke.mockImplementation(async (cmd: string, a: Record<string, unknown>) =>
			JSON.stringify({ cmd, ...a })
		);
	}

	it('reads a workdir-relative path', async () => {
		echoArgs();
		const out = await call('fs_read_text', { path: 'notes/a.md' });
		expect(JSON.parse(out.result)).toEqual({
			cmd: 'fs_read_text',
			workdir: '/tmp/work',
			relPath: 'notes/a.md'
		});
	});

	it('floors a fractional window and drops non-positive or non-numeric values', async () => {
		echoArgs();
		const a = JSON.parse((await call('fs_read_text', { path: 'a', offset: 3.9, limit: 0 })).result);
		expect(a.offset).toBe(3);
		expect('limit' in a).toBe(false);

		const b = JSON.parse(
			(await call('fs_read_text', { path: 'a', offset: -5, limit: 'lots' })).result
		);
		expect('offset' in b).toBe(false);
		expect('limit' in b).toBe(false);
	});

	it('accepts numeric strings for the window (schema coercion)', async () => {
		echoArgs();
		const a = JSON.parse(
			(await call('fs_read_text', { path: 'a', offset: '10', limit: '5' })).result
		);
		expect(a).toMatchObject({ offset: 10, limit: 5 });
	});

	it('returns a tool error when the backend rejects with an Error', async () => {
		invokeRejects(new Error('file is binary'));
		expect(errorOf(await call('fs_read_text', { path: 'a.bin' }))).toBe(
			'fs_read_text failed: file is binary'
		);
	});

	it('returns a tool error when the backend rejects with a string', async () => {
		invokeRejects('not found: a.txt');
		expect(errorOf(await call('fs_read_text', { path: 'a.txt' }))).toBe(
			'fs_read_text failed: not found: a.txt'
		);
	});

	it('reports the absolute command when Shell mode fails', async () => {
		ctx = { ...ctx, workingDir: null, shellMode: true, shellCwd: '/home/u' } as ToolContext;
		invokeRejects('permission denied');
		expect(errorOf(await call('fs_read_text', { path: 'secret' }))).toBe(
			'fs_read_text_absolute failed: permission denied'
		);
	});

	it('refuses without a working directory outside Shell mode', async () => {
		ctx = { ...ctx, workingDir: null } as ToolContext;
		expect(errorOf(await call('fs_read_text', { path: 'a' }))).toBe('No working directory set');
	});
});

describe('document readers', () => {
	it.each(['fs_read_pdf', 'fs_read_docx', 'fs_read_xlsx'])(
		'%s returns the extracted text',
		async (tool) => {
			mocks.invoke.mockResolvedValue('extracted');
			expect((await call(tool, { path: 'x' })).result).toBe('extracted');
		}
	);

	it.each(['fs_read_pdf', 'fs_read_docx', 'fs_read_xlsx'])(
		'%s returns a tool error when the backend rejects',
		async (tool) => {
			invokeRejects(new Error('corrupt archive'));
			expect(errorOf(await call(tool, { path: 'x' }))).toBe(`${tool} failed: corrupt archive`);
		}
	);

	it('fs_read_xlsx passes the sheet name through', async () => {
		mocks.invoke.mockImplementation(
			async (_cmd: string, a: { sheet?: string }) => `sheet=${a.sheet}`
		);
		expect((await call('fs_read_xlsx', { path: 'b.xlsx', sheet: 'Q3' })).result).toBe('sheet=Q3');
		expect((await call('fs_read_xlsx', { path: 'b.xlsx' })).result).toBe('sheet=undefined');
	});
});

describe('fs_read_image', () => {
	it('loads the image, queues it for the model and returns a thumbnail', async () => {
		mocks.invoke.mockResolvedValue('data:image/png;base64,AAA');
		const out = await call('fs_read_image', { path: 'pics/cat.png' });
		expect(out.result).toMatch(/^Image loaded: pics\/cat\.png\./);
		expect(out.thumbDataUrl).toBe('data:image/png;base64,AAA');
		expect(ctx.pendingImages).toEqual([
			{ path: 'pics/cat.png', dataUrl: 'data:image/png;base64,AAA' }
		]);
	});

	it('refuses once the pending-image budget is used up', async () => {
		for (let i = 0; i < MAX_PENDING_IMAGES; i++) {
			ctx.pendingImages.push({ path: `${i}.png`, dataUrl: 'x' });
		}
		mocks.invoke.mockResolvedValue('data:image/png;base64,BBB');
		const out = await call('fs_read_image', { path: 'one-more.png' });
		expect(errorOf(out)).toMatch(
			new RegExp(`^Too many images pending \\(${MAX_PENDING_IMAGES}\\)`)
		);
		expect(ctx.pendingImages).toHaveLength(MAX_PENDING_IMAGES);
	});

	it('returns a tool error and queues nothing when the backend rejects', async () => {
		invokeRejects(new Error('unsupported image format'));
		const out = await call('fs_read_image', { path: 'a.heic' });
		expect(errorOf(out)).toBe('fs_read_image failed: unsupported image format');
		expect(out.thumbDataUrl).toBeUndefined();
		expect(ctx.pendingImages).toHaveLength(0);
	});
});

describe('fs_read_pdf_pages', () => {
	it('queues each rendered page and says how many', async () => {
		mocks.renderPdfPages.mockResolvedValue(['p1', 'p2']);
		const out = await call('fs_read_pdf_pages', { path: 'form.pdf' });
		expect(out.result).toMatch(/^Rendered 2 pages of form\.pdf as images\./);
		expect(ctx.pendingImages.map((p) => p.path)).toEqual(['form.pdf#page1', 'form.pdf#page2']);
	});

	it('uses the singular for one page', async () => {
		mocks.renderPdfPages.mockResolvedValue(['p1']);
		expect((await call('fs_read_pdf_pages', { path: 'a.pdf' })).result).toMatch(
			/^Rendered 1 page of a\.pdf/
		);
	});

	it('refuses while other images are pending', async () => {
		ctx.pendingImages.push({ path: 'x.png', dataUrl: 'x' });
		mocks.renderPdfPages.mockResolvedValue(['p1']);
		const out = await call('fs_read_pdf_pages', { path: 'a.pdf' });
		expect(errorOf(out)).toMatch(/^You already have 1 image\(s\) pending/);
		expect(ctx.pendingImages).toHaveLength(1);
	});

	it('returns a tool error when rendering fails', async () => {
		mocks.renderPdfPages.mockRejectedValue(new Error('encrypted PDF'));
		const out = await call('fs_read_pdf_pages', { path: 'a.pdf' });
		expect(errorOf(out)).toBe('fs_read_pdf_pages failed: encrypted PDF');
		expect(ctx.pendingImages).toHaveLength(0);
	});
});
