import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstImageBytes, saveScreenshot, takeScreenshotName } from './_playwrightShot';
import { prepareSave, writeSaved } from '#lib/agent/tools/_saveGenerated.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

vi.mock('#lib/agent/tools/_saveGenerated.ts', () => ({
	isSaveTarget: (v: object) => 'mode' in v,
	prepareSave: vi.fn(),
	writeSaved: vi.fn()
}));

const playwright = {
	name: 'browser_take_screenshot',
	inputSchema: { type: 'object', properties: { filename: { type: 'string' } } }
};

beforeEach(() => vi.mocked(prepareSave).mockReset());

describe('takeScreenshotName', () => {
	it('takes the name off a named Playwright screenshot', () => {
		expect(takeScreenshotName(playwright, { type: 'png', filename: ' a.png ' })).toEqual({
			args: { type: 'png' },
			filename: 'a.png'
		});
	});

	it('leaves anything else alone', () => {
		expect(takeScreenshotName(playwright, { type: 'png' })).toBeNull();
		expect(takeScreenshotName(playwright, { filename: '  ' })).toBeNull();
		expect(takeScreenshotName({ ...playwright, name: 'other' }, { filename: 'a.png' })).toBeNull();
		// Same name, but not Playwright's parameter.
		expect(
			takeScreenshotName(
				{ name: playwright.name, inputSchema: { properties: {} } },
				{ filename: 'a' }
			)
		).toBeNull();
	});
});

describe('saveScreenshot', () => {
	const content = [
		{ type: 'text', text: 'shot' },
		{ type: 'image', data: btoa('PNG'), mimeType: 'image/png' }
	];

	it('writes the picture at the name, replacing an older shot', async () => {
		const target = { mode: 'project' as const, path: '/p/shots/a.png', overwrite: true };
		vi.mocked(prepareSave).mockResolvedValue(target);
		vi.mocked(writeSaved).mockResolvedValue(null);
		const ctx = makeToolContext();
		expect(await saveScreenshot('shots/a.png', content, ctx)).toBe(
			'Saved as /p/shots/a.png in the working folder.'
		);
		expect(prepareSave).toHaveBeenCalledWith('shots/a.png', true, ctx, 'browser_take_screenshot');
		expect(new TextDecoder().decode(vi.mocked(writeSaved).mock.calls[0][1])).toBe('PNG');
	});

	it('says why when it cannot', async () => {
		vi.mocked(prepareSave).mockResolvedValue({ result: '{"error":"read-only"}' });
		expect(await saveScreenshot('a.png', content, makeToolContext())).toBe(
			'Not saved as a.png: read-only'
		);
		expect(await saveScreenshot('a.png', [], makeToolContext())).toBe(
			'Not saved as a.png: the result had no picture.'
		);
	});
});

describe('firstImageBytes', () => {
	it('decodes the first image block', () => {
		const bytes = firstImageBytes([{ type: 'image', data: btoa('\x00\xff') }]);
		expect([...bytes!]).toEqual([0, 255]);
		expect(firstImageBytes(null)).toBeNull();
	});
});
