import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn(), ask: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/youtubeUploadApproval.svelte.ts', () => ({ askYoutubeUpload: state.ask }));

vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return { ...actual, getSettings: () => ({ ...actual.getSettings(), videoEditingEnabled: true }) };
});

import { executeTool } from '#lib/agent/tools/index.ts';
import { changes, checkProposal, withChapters } from './youtube-upload';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

const found = { path: '/usr/bin/x', version: 'x', source: 'path' as const };
const plan = {
	render: 'ep010/renders/ep010-20261025-1410.mp4',
	durationSecs: 723,
	sizeBytes: 400 * 1024 ** 2,
	thumbnail: 'ep010/ep010.thumbnail.jpg',
	thumbnailDataUrl: 'data:image/jpeg;base64,AA',
	chapters: '0:00 Intro\n1:05 Building\n9:30 Outro'
};
const task = {
	id: 'upload-1',
	kind: 'upload',
	label: 'Uploading ep010-20261025-1410 to YouTube',
	owner: 'chat:c1',
	workingDir: '/videos',
	state: 'running',
	percent: 0,
	etaSecs: null,
	startedMs: 1
};

beforeEach(() => {
	state.ask.mockReset();
	state.invoke.mockReset().mockImplementation(
		invokeRouter({
			youtube_account: () => ({ email: 'tim@example.com' }),
			youtube_upload_plan: () => plan,
			youtube_upload_start: () => task
		})
	);
	_setVideoBinariesForTests({ ffmpeg: found, ffprobe: found, melt: found, hints: [] });
});

const chat = () =>
	makeToolContext({ interactive: true, workingDir: '/videos', conversationId: 'c1' });

describe('the proposal', () => {
	it('adds the chapters once, after a blank line', () => {
		expect(withChapters('About this one.', '0:00 Intro')).toBe('About this one.\n\n0:00 Intro');
		expect(withChapters('About.\n\n0:00 Intro', '0:00 Intro')).toBe('About.\n\n0:00 Intro');
		expect(withChapters('About.', null)).toBe('About.');
	});

	it("is checked against YouTube's limits", () => {
		expect(checkProposal('Episode 12', 'ok', ['a'])).toEqual([]);
		expect(checkProposal('', 'ok', [])[0]).toContain('1 to 100');
		expect(checkProposal('x'.repeat(101), 'ok', [])[0]).toContain('1 to 100');
		expect(checkProposal('a <b>', 'ok', [])[0]).toContain('< or >');
		expect(checkProposal('t', 'é'.repeat(2600), [])[0]).toContain('5,000');
	});

	it('names what the user changed', () => {
		const proposed = { title: 'Ep 12', description: 'd', tags: ['a'], categoryId: '22' };
		const meta = {
			title: 'Episode 12',
			description: 'd',
			tags: ['a'],
			categoryId: '20',
			visibility: 'private' as const,
			madeForKids: false
		};
		expect(changes(proposed, meta)).toEqual(['title (now "Episode 12")', 'category']);
	});
});

describe('youtube_upload', () => {
	it('sends nothing until the user confirms, and then what they confirmed', async () => {
		state.ask.mockResolvedValue({
			kind: 'upload',
			meta: {
				title: 'Episode 12',
				description: 'About.\n\n0:00 Intro\n1:05 Building\n9:30 Outro',
				tags: ['games'],
				categoryId: '20',
				visibility: 'unlisted',
				madeForKids: false
			}
		});
		const out = await executeTool(
			'youtube_upload',
			{
				episode: 'ep010',
				title: 'Episode 12',
				description: 'About.',
				tags: ['games'],
				category_id: '20'
			},
			chat()
		);
		const asked = state.ask.mock.calls[0][0];
		expect(asked).toMatchObject({
			render: plan.render,
			email: 'tim@example.com',
			description: 'About.\n\n0:00 Intro\n1:05 Building\n9:30 Outro',
			thumbnailDataUrl: plan.thumbnailDataUrl
		});
		const start = state.invoke.mock.calls.find(([c]) => c === 'youtube_upload_start');
		expect(start?.[1].request).toMatchObject({
			render: plan.render,
			thumbnail: plan.thumbnail,
			owner: 'chat:c1',
			meta: { visibility: 'unlisted', madeForKids: false }
		});
		expect(out.result).toContain('as unlisted');
		expect(out.artifacts?.[0]).toMatchObject({ kind: 'videoTask', taskId: 'upload-1' });
	});

	it('a cancel in the dialog sends nothing', async () => {
		state.ask.mockResolvedValue({ kind: 'cancelled', reason: 'The user cancelled the upload.' });
		const out = await executeTool('youtube_upload', { title: 'T', description: 'D' }, chat());
		expect(out.result).toBe('The user cancelled the upload.');
		expect(state.invoke.mock.calls.some(([c]) => c === 'youtube_upload_start')).toBe(false);
	});

	it('refuses when unattended or signed out', async () => {
		const job = makeToolContext({ interactive: false, workingDir: '/videos' });
		expect(
			(await executeTool('youtube_upload', { title: 'T', description: 'D' }, job)).result
		).toContain('conversation');
		state.invoke.mockImplementation(invokeRouter({ youtube_account: () => null }));
		const out = await executeTool('youtube_upload', { title: 'T', description: 'D' }, chat());
		expect(out.result).toContain('Sign in to YouTube in Settings → Video editing');
		expect(state.ask).not.toHaveBeenCalled();
	});

	it('a proposal over the limits never reaches the dialog', async () => {
		const out = await executeTool('youtube_upload', { title: '', description: 'D' }, chat());
		expect(out.result).toContain('Not asked');
		expect(state.ask).not.toHaveBeenCalled();
	});
});
