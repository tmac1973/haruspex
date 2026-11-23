import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { MAX_CHARS, parseSpeechArgs, shortNote } from './speech-gen';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { _setSavedVoicesForTests } from '#lib/audio/savedVoices.ts';

const HASH = 'a'.repeat(64);
const URL = `haruspex-audio://localhost/${HASH}`;
const chat = makeToolContext({ interactive: true, conversationId: 'chat-1' });

const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);
const paramsOf = (o: Parameters<typeof getToolSchemas>[0]) =>
	Object.keys(
		(
			getToolSchemas(o).find((s) => s.function.name === 'generate_speech')!.function.parameters as {
				properties: Record<string, unknown>;
			}
		).properties
	);

beforeEach(() => {
	vi.mocked(invoke)
		.mockReset()
		.mockImplementation(
			invokeRouter({
				tts_synthesize_to_cache: () => ({
					hash: HASH,
					mime: 'audio/wav',
					bytes: 4800044,
					seconds: 100.4
				}),
				audio_read_bytes: () => new Uint8Array([1, 2]).buffer
			})
		);
});

describe('generate_speech is offered', () => {
	it('in Chat with someone there; with path only given a working folder', () => {
		expect(names({ hasWorkingDir: false, interactive: true })).toContain('generate_speech');
		expect(paramsOf({ hasWorkingDir: false, interactive: true })).not.toContain('path');
		expect(paramsOf({ hasWorkingDir: true, interactive: true })).toContain('path');
	});

	it('in the Code tab', () => {
		expect(names({ hasWorkingDir: true, interactive: true, codeMode: true })).toContain(
			'generate_speech'
		);
	});

	it('not in Shell, a Code session’s shell, a subtask or a job', () => {
		expect(names({ hasWorkingDir: true, interactive: true, shellMode: true })).not.toContain(
			'generate_speech'
		);
		expect(
			names({ hasWorkingDir: true, interactive: true, codeMode: true, shellMode: true })
		).not.toContain('generate_speech');
		expect(
			names({ hasWorkingDir: true, interactive: true, codeMode: true, subtask: true })
		).not.toContain('generate_speech');
		expect(names({ hasWorkingDir: true, interactive: false })).not.toContain('generate_speech');
	});
});

describe('parseSpeechArgs', () => {
	it('defaults the voice, speed and title', () => {
		const got = parseSpeechArgs(
			{ text: 'Welcome back, traveller. The road north is closed.' },
			'am_adam'
		);
		expect(got).toMatchObject({
			voice: 'am_adam',
			speed: 1,
			title: 'Welcome back, traveller. The road north…',
			path: '',
			notes: []
		});
	});

	it('clamps the speed and replaces an unknown voice, saying so', () => {
		const got = parseSpeechArgs({ text: 'Hi.', voice: 'zz_nobody', speed: 5 }, 'af_heart');
		expect(got).toMatchObject({ voice: 'af_heart', speed: 2 });
		expect((got as { notes: string[] }).notes).toHaveLength(2);
	});

	it('refuses no text, too much text, and a path that is not .wav', () => {
		expect(parseSpeechArgs({}, 'af_heart')).toContain('needs the "text"');
		expect(parseSpeechArgs({ text: 'a'.repeat(MAX_CHARS + 1) }, 'af_heart')).toContain('Split it');
		expect(parseSpeechArgs({ text: 'Hi.', path: 'a.mp3' }, 'af_heart')).toBe(
			'path must end in .wav.'
		);
	});
});

describe('generate_speech', () => {
	it('speaks into the cache, linked to the chat, and answers with the player line', async () => {
		const out = await executeTool(
			'generate_speech',
			{ text: 'Chapter one.', voice: 'bm_none', title: 'Intro', speed: 0.9 },
			chat
		);
		expect(invoke).toHaveBeenCalledWith('tts_synthesize_to_cache', {
			text: 'Chapter one.',
			voice: 'af_heart',
			speed: 0.9,
			title: 'Intro',
			conversationId: 'chat-1',
			codeSessionId: null
		});
		expect(out.result).toContain('Made "Intro" (1 min 40 s, voice af_heart).');
		expect(out.result).toContain(`Put ![Intro](${URL}) in your answer.`);
		expect(out.result).toContain('There is no voice "bm_none"');
		expect(out.artifacts).toEqual([{ kind: 'audio', mime: 'audio/wav', src: URL, title: 'Intro' }]);
	});

	it('passes on what koko said when it fails', async () => {
		vi.mocked(invoke).mockRejectedValueOnce('TTS failed: no model');
		const out = await executeTool('generate_speech', { text: 'Hi.' }, chat);
		expect(out.result).toContain('Could not make it: TTS failed: no model');
	});
});

describe('shortNote', () => {
	const text = 'a'.repeat(300); // about 20 s

	it('flags audio far shorter than the text takes', () => {
		expect(shortNote(text, 1, 2)).toContain('probably broken');
		expect(shortNote(text, 2, 2)).toContain('about 10 s');
	});

	it('leaves normal audio and short lines alone', () => {
		expect(shortNote(text, 1, 18)).toBeNull();
		expect(shortNote('Hi.', 1, 0.4)).toBeNull();
	});
});

describe('generate_speech on a llama.cpp speech server', () => {
	const take = { hash: 'b'.repeat(64), mime: 'audio/wav', bytes: 100, seconds: 2.5, note: null };

	beforeEach(() => {
		updateSettings({
			speechBackendKind: 'llama-server',
			speechServerBaseUrl: 'http://box:3000',
			speechServerApiKeyId: null,
			speechServerModelId: 'qwen3-tts'
		});
		_setSavedVoicesForTests([
			{
				id: 'tim-abc123',
				name: 'Tim',
				source: 'file',
				sourcePath: null,
				fromSecs: null,
				toSecs: null,
				refText: 'hello',
				secs: 8,
				consentedAt: 1
			}
		]);
		vi.mocked(invoke)
			.mockReset()
			.mockImplementation(
				invokeRouter({
					speech_server_synthesize: () => take,
					audio_stretch: () => ({ ...take, hash: 'c'.repeat(64), seconds: 3.125 })
				})
			);
	});

	afterEach(() => updateSettings({ speechBackendKind: 'kokoro' }));

	it('speaks in a saved voice with the seed, and never sends a speed', async () => {
		const out = await executeTool(
			'generate_speech',
			{ text: 'This is a test.', voice: 'tim', seed: 4, title: 'Test' },
			chat
		);
		expect(invoke).toHaveBeenCalledWith(
			'speech_server_synthesize',
			expect.objectContaining({
				baseUrl: 'http://box:3000',
				model: 'qwen3-tts',
				voice: 'Tim',
				seed: 4,
				conversationId: 'chat-1'
			})
		);
		expect(vi.mocked(invoke).mock.calls[0][1]).not.toHaveProperty('speed');
		expect(invoke).not.toHaveBeenCalledWith('audio_stretch', expect.anything());
		expect(invoke).not.toHaveBeenCalledWith('tts_synthesize_to_cache', expect.anything());
		expect(out.result).toContain(`voice Tim, 2.50 s, take ${'b'.repeat(12)}`);
	});

	it('changes the pace after, with audio_stretch', async () => {
		const out = await executeTool('generate_speech', { text: 'Slow down.', speed: 0.8 }, chat);
		expect(invoke).toHaveBeenCalledWith(
			'audio_stretch',
			expect.objectContaining({ hash: 'b'.repeat(64), factor: 0.8 })
		);
		expect(out.result).toContain(`3.13 s, take ${'c'.repeat(12)}`);
		expect(out.result).toContain("voice the server's own voice");
	});

	it('drops a Kokoro voice, saying so', () => {
		const got = parseSpeechArgs({ text: 'Hi.', voice: 'af_heart' }, 'af_heart', 'llama-server');
		expect(got).toMatchObject({ voice: null });
		expect((got as { notes: string[] }).notes[0]).toContain('is a Kokoro voice');
	});
});
