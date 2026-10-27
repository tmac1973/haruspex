import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	invoke: vi.fn(),
	generate: vi.fn(),
	resume: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({
			...actual.getSettings(),
			musicBackendKind: 'llama-toolchest',
			musicDefaultDurationSec: 45
		})
	};
});
vi.mock('#lib/music/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/music/index.ts')>()),
	resolveMusicBackend: () => ({ kind: 'llama-toolchest', generate: state.generate })
}));
vi.mock('#lib/music/registry.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/music/registry.ts')>()),
	getMusicBackend: (kind: string) =>
		kind === 'ace-server' ? { kind, resume: state.resume } : undefined
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import {
	hashedSong,
	musicAnswerText,
	runMusicJob,
	songUrl,
	type MusicTaskSpec
} from './_musicJob.ts';
import { _resetTasksForTests, getTask } from '#lib/tasks/store.svelte.ts';
import type { MusicJobHandle, MusicRequest } from '#lib/music/types.ts';

const HASH = 'e'.repeat(64);
const URL = `haruspex-audio://localhost/${HASH}`;

const made = {
	hash: HASH,
	url: URL,
	mime: 'audio/mpeg',
	durationSec: 45,
	seed: 7,
	model: 'ace-gpu2',
	bpm: 82,
	key: 'D minor'
};

const request: MusicRequest = {
	title: 'Rain',
	caption: 'lo-fi, rain',
	instrumental: true,
	durationSec: 45,
	seed: 7,
	format: 'mp3'
};

function spec(over: Partial<MusicTaskSpec> = {}): MusicTaskSpec {
	return {
		request,
		notes: [],
		save: null,
		conversationId: 'c1',
		codeSessionId: null,
		...over
	};
}

beforeEach(() => {
	_resetTasksForTests();
	for (const f of [state.invoke, state.generate, state.resume]) f.mockReset();
	state.generate.mockResolvedValue(made);
	state.resume.mockResolvedValue(made);
	state.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
		if (cmd === 'audio_read_bytes') return new Uint8Array([9, 9]).buffer;
		if (cmd === 'audio_store_bytes') return { hash: 'f'.repeat(64), mime: 'audio/wav', bytes: 3 };
		if (cmd === 'task_create') {
			return {
				id: 'music-1',
				kind: 'music',
				owner: args.owner,
				label: args.label,
				state: 'pending',
				follower: 'frontend',
				spec: args.spec,
				startedMs: 1,
				noticeDelivered: false
			};
		}
		return null;
	});
});

describe('runMusicJob', () => {
	it('makes the song for its chat and says what it made', async () => {
		const onHandle = vi.fn();
		const out = await runMusicJob(spec({ notes: ['Length set to 240 s (5–240).'] }), {
			onHandle
		});
		expect(state.generate).toHaveBeenCalledWith(
			request,
			expect.objectContaining({ onHandle, conversationId: 'c1', codeSessionId: undefined })
		);
		expect(out).toEqual({
			hash: HASH,
			mime: 'audio/mpeg',
			title: 'Rain',
			durationSec: 45,
			seed: 7,
			model: 'ace-gpu2',
			bpm: 82,
			key: 'D minor',
			notes: ['Length set to 240 s (5–240).'],
			saved: null
		});
		expect(songUrl(out)).toContain(HASH);
	});

	it('follows a job an earlier run sent, on the backend that sent it', async () => {
		const handle: MusicJobHandle = {
			backend: 'ace-server',
			baseUrl: 'http://box:8083',
			id: 'syn',
			model: 'xl',
			stage: 'synth'
		};
		await runMusicJob(spec(), {}, handle);
		expect(state.resume).toHaveBeenCalledWith(handle, request, expect.anything());
		expect(state.generate).not.toHaveBeenCalled();
		await expect(
			runMusicJob(spec(), {}, { ...handle, backend: 'llama-toolchest' })
		).rejects.toThrow(/can't pick a song up again/);
	});

	it('saves where the turn asked, and says so', async () => {
		const out = await runMusicJob(
			spec({ save: { mode: 'chat', workdir: '/w', path: 'rain.mp3', overwrite: false } }),
			{}
		);
		expect(state.invoke).toHaveBeenCalledWith('fs_write_bytes', {
			workdir: '/w',
			relPath: 'rain.mp3',
			bytes: [9, 9],
			overwrite: false,
			dryRun: false
		});
		expect(out.saved).toBe('Wrote rain.mp3.');
	});
});

describe('the answer', () => {
	it('is the same from a background task as from the tool', async () => {
		const blocking = await executeTool(
			'generate_music',
			{ caption: 'lo-fi, rain', title: 'Rain', seed: 7 },
			makeToolContext({ interactive: true, conversationId: 'c1' })
		);
		const r = await runMusicJob(spec(), {});
		expect(
			musicAnswerText({ made: { ...r, url: URL }, title: r.title, saved: r.saved, notes: r.notes })
		).toBe(blocking.result);
	});
});

describe('hashedSong', () => {
	it('keeps a cached song as it is, and stores a file’s bytes for the chat', async () => {
		const ctx = makeToolContext({ interactive: true, conversationId: 'c1' });
		expect(await hashedSong({ name: 'a.mp3', hash: HASH }, ctx)).toEqual({
			name: 'a.mp3',
			hash: HASH
		});
		expect(await hashedSong({ name: 'take.wav', bytes: [1, 2, 3] }, ctx)).toEqual({
			name: 'take.wav',
			hash: 'f'.repeat(64)
		});
		expect(state.invoke).toHaveBeenCalledWith('audio_store_bytes', new Uint8Array([1, 2, 3]), {
			headers: { 'x-mime': 'audio/wav', 'x-conversation-id': 'c1' }
		});
	});
});

describe('background: true', () => {
	const chat = makeToolContext({ interactive: true, conversationId: 'c1' });

	it('records a task with the settled request and answers at once, without making it', async () => {
		const out = await executeTool(
			'generate_music',
			{ caption: 'lo-fi, rain', title: 'Rain', duration_seconds: 900, background: true },
			chat
		);
		expect(state.generate).not.toHaveBeenCalled();
		const [, created] = state.invoke.mock.calls.find(([c]) => c === 'task_create')!;
		expect(created).toMatchObject({
			kind: 'music',
			owner: 'chat:c1',
			label: 'Making Rain',
			spec: {
				request: { title: 'Rain', caption: 'lo-fi, rain', durationSec: 240 },
				notes: ['Length set to 240 s (5–240).'],
				save: null,
				conversationId: 'c1',
				codeSessionId: null
			}
		});
		expect(typeof created.spec.request.seed).toBe('number');
		expect(out.result).toContain('Started in the background (task music-1)');
		expect(out.result).toContain('do NOT poll');
		expect(out.artifacts).toEqual([{ kind: 'task', taskId: 'music-1', label: 'Making Rain' }]);
		expect(getTask('music-1')).toBeTruthy();
	});

	it('in a Code session, saves into its project with no turn behind it', async () => {
		const code = makeToolContext({
			interactive: true,
			codeSessionId: 's1',
			workingDir: '/proj'
		});
		await executeTool(
			'generate_music',
			{ caption: 'x', path: 'audio/x.mp3', background: true },
			code
		);
		const [, created] = state.invoke.mock.calls.find(([c]) => c === 'task_create')!;
		expect(created.owner).toBe('code:s1');
		expect(created.spec.save).toMatchObject({ mode: 'chat', workdir: '/proj', overwrite: false });
		expect(created.spec.save.path).toMatch(/audio\/x\.mp3$/);
	});

	it('makes it as before without it, or with no chat to own a task', async () => {
		const out = await executeTool(
			'generate_music',
			{ caption: 'x', background: true },
			makeToolContext({ interactive: true })
		);
		expect(state.generate).toHaveBeenCalled();
		expect(out.result).toContain('Made "X"');
	});

	it('is offered on both song tools only where a task can have an owner', () => {
		const params = (name: string, taskOwner?: string) =>
			getToolSchemas({ hasWorkingDir: false, interactive: true, taskOwner }).find(
				(s) => s.function.name === name
			)?.function.parameters as { properties: Record<string, unknown> };
		for (const name of ['generate_music', 'edit_music']) {
			expect(params(name, 'chat:c1').properties.background).toBeTruthy();
			expect(params(name, undefined).properties.background).toBeUndefined();
		}
	});
});
