import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import type { SearchStep } from '#lib/agent/loop.ts';
import { imageSrc } from '#lib/images/url.ts';
import { invokeArgs } from '#lib/testing/invoke.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { imageSize, stepImageSrc, storeStepImage, withStoredImage } from './stepImages';

const HASH = 'a'.repeat(64);

/** A PNG's signature and IHDR, enough for `imageSize`. */
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

const SHEET = `data:image/png;base64,${bytesToBase64(pngHeader(1200, 800))}`;

function step(id: string, over: Partial<SearchStep> = {}): SearchStep {
	return { id, toolName: 'check_3d', query: 'tower.js', status: 'done', ...over };
}

describe('imageSize', () => {
	it("reads a PNG's size from its header", () => {
		expect(imageSize(pngHeader(1200, 800))).toEqual({ width: 1200, height: 800 });
	});

	it('gives zeros for anything else', () => {
		expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual({ width: 0, height: 0 });
	});
});

describe('storeStepImage', () => {
	beforeEach(() => {
		(invoke as Mock).mockReset();
	});

	it('stores the bytes linked to the session and returns the hash', async () => {
		(invoke as Mock).mockResolvedValue(HASH);
		expect(await storeStepImage(SHEET, 's1')).toBe(HASH);
		const args = invokeArgs(invoke as Mock, 'image_store_bytes');
		expect(args).toMatchObject({
			mime: 'image/png',
			width: 1200,
			height: 800,
			conversationId: null,
			codeSessionId: 's1'
		});
		expect((args.bytes as number[]).length).toBe(24);
	});

	it('gives null when the cache refuses it, so the step keeps its data URL', async () => {
		(invoke as Mock).mockImplementation(async () => {
			throw new Error('too big');
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await storeStepImage(SHEET, 's1')).toBeNull();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('leaves anything but a base64 data URL alone', async () => {
		expect(await storeStepImage('https://e.com/x.png', 's1')).toBeNull();
		expect(invoke).not.toHaveBeenCalled();
	});
});

describe('withStoredImage', () => {
	it('names the picture by hash on the steps that show it', () => {
		const steps = [step('a', { thumbDataUrl: SHEET }), step('b')];
		const next = withStoredImage(steps, SHEET, HASH)!;
		expect(next[0].thumbHash).toBe(HASH);
		expect('thumbDataUrl' in next[0]).toBe(false);
		expect(next[1]).toBe(steps[1]);
	});

	it('gives null when no step shows it', () => {
		expect(withStoredImage([step('a')], SHEET, HASH)).toBeNull();
	});
});

describe('stepImageSrc', () => {
	it('prefers the data URL, then the cached picture, else nothing', () => {
		expect(stepImageSrc({ thumbDataUrl: SHEET, thumbHash: HASH })).toBe(SHEET);
		expect(stepImageSrc({ thumbHash: HASH })).toBe(imageSrc(HASH));
		expect(stepImageSrc({})).toBeNull();
	});
});
