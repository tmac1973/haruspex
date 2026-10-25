import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import {
	_resetForTests,
	buildVideoNotice,
	hasVideoNotices,
	isVideoNotice,
	setChatVideoTaskHandler,
	setVideoTaskHandler,
	takeVideoNotices,
	videoOwner
} from './taskWatch';
import { _resetVideoTasksForTests, upsertVideoTask, videoTask } from './tasks.svelte';
import type { VideoTask } from '#lib/ipc/gen/VideoTask.ts';

const base = {
	id: 'render-1',
	kind: 'render' as const,
	label: 'Rendering ep012',
	owner: 'chat:c1',
	workingDir: '/videos',
	percent: 40,
	etaSecs: 30,
	startedMs: 1
};

const running: VideoTask = { ...base, state: 'running' };
const done: VideoTask = {
	...base,
	state: 'done',
	path: 'ep012/renders/ep012-20261025-1410.mp4',
	absPath: '/videos/ep012/renders/ep012-20261025-1410.mp4',
	check: {
		durationSecs: 723,
		expectedSecs: 723,
		sizeBytes: 412 * 1024 * 1024,
		width: 1920,
		height: 1080,
		fps: 60,
		hasAudio: true,
		loudness: { lufs: -14.2, lra: 6, truePeakDb: -1.4 },
		problems: []
	}
};

beforeEach(() => {
	_resetForTests();
	_resetVideoTasksForTests();
});

describe('notices', () => {
	it('say what was made, how long, how big and how loud', () => {
		const text = buildVideoNotice(done);
		expect(text).toBe(
			'Video render finished: ep012/renders/ep012-20261025-1410.mp4. 12:03, 412 MB, 1920×1080, -14.2 LUFS. No problems.'
		);
		expect(isVideoNotice(text)).toBe(true);
		expect(isVideoNotice('Video render is great')).toBe(false);
	});

	it('carry melt’s last words when a render fails', () => {
		const failed: VideoTask = {
			...base,
			state: 'failed',
			message: 'melt stopped',
			logTail: 'boom'
		};
		expect(buildVideoNotice(failed)).toContain('--- melt said ---\nboom');
		expect(buildVideoNotice({ ...base, state: 'cancelled' })).toContain('cancelled');
	});

	it('name their owner from the turn', () => {
		expect(videoOwner({ conversationId: 'c1' })).toBe('chat:c1');
		expect(videoOwner({ codeSessionId: 's1', conversationId: 'c1' })).toBe('code:s1');
	});
});

describe('when a task ends', () => {
	it('its owner is told once, and takes the notice', () => {
		const code = vi.fn();
		setVideoTaskHandler('code:s1', code);
		upsertVideoTask({ ...running, owner: 'code:s1' });
		expect(code).not.toHaveBeenCalled();
		upsertVideoTask({ ...done, owner: 'code:s1' });
		upsertVideoTask({ ...done, owner: 'code:s1' });
		expect(code).toHaveBeenCalledTimes(1);
		expect(takeVideoNotices('code:s1')).toContain('Video render finished');
		expect(hasVideoNotices('code:s1')).toBe(false);
	});

	it('the Chat store hears about every chat', () => {
		const chat = vi.fn();
		setChatVideoTaskHandler(chat);
		upsertVideoTask(running);
		upsertVideoTask(done);
		expect(chat).toHaveBeenCalledWith('chat:c1');
		expect(videoTask('render-1')?.state).toBe('done');
	});

	it('notices wait for an owner that has no handler yet', () => {
		upsertVideoTask({ ...done, owner: 'code:gone' });
		expect(takeVideoNotices('code:gone')).toContain('finished');
	});
});
