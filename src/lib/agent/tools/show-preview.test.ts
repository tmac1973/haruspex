import { beforeEach, describe, expect, it, vi } from 'vitest';

const openPreview = vi.fn();
vi.mock('#lib/preview/open.ts', () => ({
	openPreview: (...a: unknown[]) => openPreview(...a)
}));

import { executeShowPreview } from './show-preview';

const ctx = {
	codeSessionId: 's1' as string | undefined,
	workingDir: '/proj',
	wslDistro: null as string | null,
	shellMode: false,
	shellCwd: null
};
const text = async (p: ReturnType<typeof executeShowPreview>) => {
	const out = await p;
	return typeof out === 'string' ? out : JSON.stringify(out);
};

beforeEach(() => {
	vi.clearAllMocks();
	openPreview.mockResolvedValue('http://127.0.0.1:9/t/mockup/index.html');
});

describe('show_preview', () => {
	it('opens a relative or absolute path as the same relative one', async () => {
		await executeShowPreview({ path: 'mockup/index.html' }, ctx);
		await executeShowPreview({ path: '/proj/mockup/index.html' }, ctx);
		expect(openPreview.mock.calls).toEqual([
			['s1', '/proj', 'mockup/index.html'],
			['s1', '/proj', 'mockup/index.html']
		]);
	});

	it('returns the address', async () => {
		expect(await text(executeShowPreview({ path: 'mockup/index.html' }, ctx))).toContain(
			'Address: http://127.0.0.1:9/t/mockup/index.html'
		);
	});

	it("passes on the server's refusal", async () => {
		openPreview.mockRejectedValue('Not found: gone.html');
		expect(await text(executeShowPreview({ path: 'gone.html' }, ctx))).toContain(
			'Not found: gone.html'
		);
	});

	it('refuses paths outside the folder before asking the server', async () => {
		for (const path of ['../x.html', '/etc/x.html', '']) {
			expect(await text(executeShowPreview({ path }, ctx))).toMatch(/Not inside|Give the path/);
		}
		expect(openPreview).not.toHaveBeenCalled();
	});

	it('refuses a WSL session and a turn with no Code session', async () => {
		expect(
			await text(executeShowPreview({ path: 'a.html' }, { ...ctx, wslDistro: 'Ubuntu' }))
		).toContain('WSL');
		expect(
			await text(executeShowPreview({ path: 'a.html' }, { ...ctx, codeSessionId: undefined }))
		).toContain('Code sessions only');
		expect(openPreview).not.toHaveBeenCalled();
	});
});
