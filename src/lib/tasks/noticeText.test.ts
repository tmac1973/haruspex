import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { isTaskNotice, joinNotices, noticeFor } from './noticeText.ts';
import {
	_resetForTests,
	setChatTaskHandler,
	setTaskHandler,
	takeNotices,
	taskOwner
} from './notices.ts';
import {
	_resetTasksForTests,
	getTask,
	hasPendingNotices,
	initTasks,
	ownersWithNotices,
	upsertTask
} from './store.svelte.ts';
import type { BackgroundTask } from './types.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

const base: BackgroundTask = {
	id: 'render-1',
	kind: 'video_render',
	owner: 'chat:c1',
	label: 'Rendering ep012',
	state: 'running',
	follower: 'rust',
	percent: 40,
	etaSecs: 30,
	phase: null,
	queuePosition: null,
	spec: { workingDir: '/videos' },
	handle: null,
	result: null,
	error: null,
	logTail: null,
	startedMs: 1,
	endedMs: null,
	noticeDelivered: false
};

const running = base;
const done: BackgroundTask = {
	...base,
	state: 'done',
	endedMs: 2,
	result: {
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
	}
};

beforeEach(() => {
	_resetForTests();
	_resetTasksForTests();
	tauri.invoke.mockReset();
});

describe('notices', () => {
	it('say what was made, how long, how big and how loud', () => {
		const { text } = noticeFor(done);
		expect(text).toMatch(/^Video render finished: ep012\/renders\/ep012-20261025-1410\.mp4\b/);
		for (const part of ['12:03', '412 MB', '1920×1080', '-14.2 LUFS', 'No problems']) {
			expect(text).toContain(part);
		}
		expect(isTaskNotice(text)).toBe(true);
		expect(isTaskNotice('Video render is great')).toBe(false);
	});

	it('carry melt’s last words when a render fails', () => {
		const failed: BackgroundTask = {
			...base,
			state: 'failed',
			error: 'melt stopped',
			logTail: 'boom'
		};
		const text = noticeFor(failed).text;
		expect(text).toMatch(/^Video render failed: melt stopped/);
		expect(text).toMatch(/boom$/);
		const cancelled = noticeFor({ ...base, state: 'cancelled' }).text;
		expect(cancelled).toMatch(/^Video render cancelled/);
		expect(cancelled).toContain('Nothing was saved');
	});

	it('report an upload with its links', () => {
		const uploaded: BackgroundTask = {
			...base,
			id: 'upload-1',
			kind: 'youtube_upload',
			state: 'done',
			result: {
				url: 'https://youtu.be/x',
				studioUrl: 'https://studio.youtube.com/video/x/edit',
				videoId: 'x',
				visibility: 'unlisted',
				problems: []
			}
		};
		const text = noticeFor(uploaded).text;
		expect(text).toMatch(/^Video upload finished: https:\/\/youtu\.be\/x\b/);
		expect(text).toContain('unlisted');
		expect(text).toContain('https://studio.youtube.com/video/x/edit');
	});

	it('say a render that died with the app failed', () => {
		const lost: BackgroundTask = { ...base, state: 'failed', error: 'Ended when the app closed.' };
		expect(noticeFor(lost).text).toBe('Video render failed: Ended when the app closed.');
	});

	it('join into one turn, a blank line between', () => {
		const other: BackgroundTask = { ...base, id: 'render-2', state: 'cancelled' };
		expect(joinNotices([done, other]).text.split('\n\n')).toHaveLength(2);
		expect(joinNotices([running]).text).toBe('');
	});

	it('name their owner from the turn', () => {
		expect(taskOwner({ conversationId: 'c1' })).toBe('chat:c1');
		expect(taskOwner({ codeSessionId: 's1', conversationId: 'c1' })).toBe('code:s1');
	});
});

describe('when a task ends', () => {
	it('its owner is told once', () => {
		const code = vi.fn();
		setTaskHandler('code:s1', code);
		upsertTask({ ...running, owner: 'code:s1' });
		expect(code).not.toHaveBeenCalled();
		upsertTask({ ...done, owner: 'code:s1' });
		upsertTask({ ...done, owner: 'code:s1' });
		expect(code).toHaveBeenCalledTimes(1);
		expect(hasPendingNotices('code:s1')).toBe(true);
	});

	it('the Chat store hears about every chat', () => {
		const chat = vi.fn();
		setChatTaskHandler(chat);
		upsertTask(running);
		upsertTask(done);
		expect(chat).toHaveBeenCalledWith(
			'chat:c1',
			expect.objectContaining({ label: 'Rendering ep012' })
		);
		expect(getTask('render-1')?.state).toBe('done');
	});

	it('nobody is told about a notice already taken', () => {
		const chat = vi.fn();
		setChatTaskHandler(chat);
		upsertTask({ ...done, noticeDelivered: true });
		expect(chat).not.toHaveBeenCalled();
		expect(hasPendingNotices('chat:c1')).toBe(false);
	});

	it('an owner takes its notices from the registry, as one turn', async () => {
		tauri.invoke.mockResolvedValueOnce([done]);
		const notice = await takeNotices('chat:c1');
		expect(tauri.invoke).toHaveBeenCalledWith('task_take_notices', { owner: 'chat:c1' });
		expect(notice.text).toContain('Video render finished');
	});
});

describe('loading the list', () => {
	it('does not announce what ended before, but says who has notices waiting', async () => {
		const chat = vi.fn();
		setChatTaskHandler(chat);
		tauri.invoke.mockResolvedValueOnce([
			done,
			{ ...done, id: 'r2', owner: 'chat:c2', noticeDelivered: true }
		]);
		await initTasks();
		expect(chat).not.toHaveBeenCalled();
		expect(ownersWithNotices('chat:')).toEqual(['chat:c1']);
	});
});

describe('a background picture’s notice', () => {
	const hash = 'c'.repeat(64);
	const picture = (visionSupported: boolean): BackgroundTask => ({
		...base,
		id: 'image-1',
		kind: 'image',
		label: 'Drawing a fox',
		state: 'done',
		follower: 'frontend',
		spec: { visionSupported },
		result: {
			op: 'draw',
			hash,
			width: 1024,
			height: 768,
			model: 'ming',
			seed: 7,
			alt: 'a fox',
			verb: 'Image ready',
			notes: [],
			saved: 'Wrote fox.png.'
		}
	});

	it('is the answer the tool would have given, with the picture to place', () => {
		const { text, images } = noticeFor(picture(true));
		expect(text).toMatch(/^Background task "Drawing a fox" finished: Image ready/);
		for (const part of [
			'1024×768',
			'seed 7',
			`![a fox](haruspex-img://localhost/${hash})`,
			'attached',
			'Wrote fox.png.'
		]) {
			expect(text).toContain(part);
		}
		expect(isTaskNotice(text)).toBe(true);
		expect(images).toEqual([hash]);
	});

	it('shows the picture only to a model that can see', () => {
		const { text, images } = noticeFor(picture(false));
		expect(text).not.toContain('attached');
		expect(images).toEqual([]);
	});

	it('reaches the model as a data URL', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter(
				{ task_take_notices: () => [picture(true)] },
				() => new Uint8Array([1, 2]).buffer
			)
		);
		const notice = await takeNotices('chat:c1');
		expect(tauri.invoke).toHaveBeenCalledWith('image_read_bytes', { hash });
		expect(notice.images).toEqual(['data:image/png;base64,AQI=']);
	});
});

describe('a background song’s notice', () => {
	const hash = 'c'.repeat(64);
	const song: BackgroundTask = {
		...base,
		id: 'music-1',
		kind: 'music',
		label: 'Making Rain',
		state: 'done',
		follower: 'frontend',
		result: {
			hash,
			mime: 'audio/mpeg',
			title: 'Rain',
			durationSec: 45,
			seed: 7,
			model: 'ace-gpu2',
			bpm: 82,
			key: 'D minor',
			notes: [],
			saved: 'Wrote rain.mp3.'
		}
	};

	it('is the answer the tool would have given, with the player line to place', () => {
		const { text, images } = noticeFor(song);
		expect(text).toMatch(/^Background task "Making Rain" finished: Made "Rain"/);
		for (const part of [
			'45 s',
			'82 bpm',
			'D minor',
			'seed 7',
			`![Rain](haruspex-audio://localhost/${hash})`,
			'Wrote rain.mp3.'
		]) {
			expect(text).toContain(part);
		}
		expect(isTaskNotice(text)).toBe(true);
		expect(images).toEqual([]);
	});
});
