import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { argsRefusal, titleOf } from './video-upscale.ts';
import type { ToolContext } from './types.ts';

const chat = { conversationId: 'c1', interactive: true } as unknown as ToolContext;

describe('upscale_video arguments', () => {
	it('needs a clip and a chat or Code session to own the task', () => {
		expect(argsRefusal({}, chat)).toMatch(/needs "video"/);
		expect(argsRefusal({ video: 'a.mp4' }, {} as ToolContext)).toMatch(/background/);
		expect(argsRefusal({ video: 'a.mp4' }, chat)).toBeNull();
	});

	it('checks the save path, the scale and the seed', () => {
		expect(argsRefusal({ video: 'a.mp4', path: 'out.mp4' }, chat)).toMatch(/\.webm/);
		expect(argsRefusal({ video: 'a.mp4', scale: 3 }, chat)).toMatch(/2 or 4/);
		expect(argsRefusal({ video: 'a.mp4', seed: -1 }, chat)).toMatch(/seed/);
	});

	it('titles the clip after its file', () => {
		expect(titleOf('clips/sunset beach.mp4')).toBe('Sunset beach');
		expect(titleOf(`haruspex-video://localhost/${'a'.repeat(64)}`)).toBe('Clip');
	});
});
