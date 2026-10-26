import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	backend: 'llama-toolchest',
	invoke: vi.fn(),
	generate: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({
			...actual.getSettings(),
			musicBackendKind: state.backend,
			musicDefaultDurationSec: 45
		})
	};
});
vi.mock('#lib/music/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/music/index.ts')>()),
	resolveMusicBackend: () => ({ kind: 'llama-toolchest', probe: vi.fn(), generate: state.generate })
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { parseMusicArgs } from './music-gen';
import { MusicBackendError } from '#lib/music/types.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const HASH = 'e'.repeat(64);
const URL = `haruspex-audio://localhost/${HASH}`;
const chat = makeToolContext({ interactive: true, conversationId: 'chat-1' });

const schemas = (o: Parameters<typeof getToolSchemas>[0]) => getToolSchemas(o);
const names = (o: Parameters<typeof getToolSchemas>[0]) => schemas(o).map((s) => s.function.name);
const paramsOf = (o: Parameters<typeof getToolSchemas>[0]) =>
	Object.keys(
		(
			schemas(o).find((s) => s.function.name === 'generate_music')!.function.parameters as {
				properties: Record<string, unknown>;
			}
		).properties
	);

beforeEach(() => {
	state.backend = 'llama-toolchest';
	state.invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'audio_read_bytes') return new Uint8Array([9, 9]).buffer;
		return null;
	});
	state.generate.mockReset().mockResolvedValue({
		hash: HASH,
		url: URL,
		mime: 'audio/mpeg',
		durationSec: 45,
		seed: 7,
		model: 'ace-gpu2',
		bpm: 82,
		key: 'D minor'
	});
});

describe('generate_music is offered', () => {
	it('in Chat with a backend and someone there; with path only given a working folder', () => {
		expect(names({ hasWorkingDir: false, interactive: true })).toContain('generate_music');
		const props = paramsOf({ hasWorkingDir: false, interactive: true });
		expect(props).not.toContain('path');
		expect(props).not.toContain('overwrite');
		expect(paramsOf({ hasWorkingDir: true, interactive: true })).toContain('path');
	});

	it('in the Code tab, with path, unless the session is read-only', () => {
		const code = { hasWorkingDir: true, interactive: true, codeMode: true };
		expect(paramsOf(code)).toContain('path');
		expect(paramsOf({ ...code, codeReadOnly: true })).not.toContain('path');
	});

	it('not in Shell, a Code session’s shell, a subtask, a job, or with no backend', () => {
		expect(names({ hasWorkingDir: true, interactive: true, shellMode: true })).not.toContain(
			'generate_music'
		);
		expect(
			names({ hasWorkingDir: true, interactive: true, codeMode: true, shellMode: true })
		).not.toContain('generate_music');
		expect(
			names({ hasWorkingDir: true, interactive: true, codeMode: true, subtask: true })
		).not.toContain('generate_music');
		expect(names({ hasWorkingDir: false, interactive: false })).not.toContain('generate_music');
		state.backend = 'none';
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('generate_music');
	});
});

describe('parseMusicArgs', () => {
	it('defaults the length, titles from the caption, and treats no lyrics as instrumental', () => {
		const a = parseMusicArgs({ caption: 'lo-fi hip hop, rain' }, 30);
		expect(a).toMatchObject({
			req: { title: 'Lo-fi Hip Hop Rain', durationSec: 30, instrumental: true, format: 'mp3' },
			notes: []
		});
	});

	it('takes a seed and a time signature, and refuses bad ones', () => {
		expect(
			parseMusicArgs({ caption: 'x', seed: 4294967295, time_signature: '3/4' }, 30)
		).toMatchObject({ seed: 4294967295, req: { timeSignature: '3' } });
		expect(parseMusicArgs({ caption: 'x', time_signature: '6' }, 30)).toMatchObject({
			seed: undefined,
			req: { timeSignature: '6' }
		});
		expect(parseMusicArgs({ caption: 'x', seed: -1 }, 30)).toMatch(/seed must be a whole number/);
		expect(parseMusicArgs({ caption: 'x', seed: 1.5 }, 30)).toMatch(/seed must be/);
		expect(parseMusicArgs({ caption: 'x', time_signature: '5/4' }, 30)).toBe(
			'time_signature must be 2/4, 3/4, 4/4 or 6/8.'
		);
	});

	it('clamps the length and says so', () => {
		const a = parseMusicArgs({ caption: 'x', duration_seconds: 300 }, 30);
		expect(a).toMatchObject({ req: { durationSec: 240 }, notes: ['Length set to 240 s (5–240).'] });
	});

	it('takes the format from the path, and refuses another extension', () => {
		const a = parseMusicArgs({ caption: 'x', path: 'assets/bgm.wav' }, 30);
		expect(a).toMatchObject({ req: { format: 'wav' }, notes: ['Saved as wav, as the path says.'] });
		expect(parseMusicArgs({ caption: 'x', path: 'bgm.ogg' }, 30)).toBe(
			'path must end in .mp3 or .wav.'
		);
		expect(parseMusicArgs({}, 30)).toBe('generate_music needs a "caption".');
	});
});

describe('generate_music', () => {
	it('makes the song for the chat and gives the model its player line', async () => {
		const out = await executeTool(
			'generate_music',
			{ caption: 'lo-fi, rain', title: 'Rain', lyrics: '[verse]\nhi' },
			chat
		);
		const [req, opts] = state.generate.mock.calls[0];
		expect(req).toMatchObject({ title: 'Rain', instrumental: false, durationSec: 45 });
		expect(opts).toMatchObject({ conversationId: 'chat-1' });
		expect(out.result).toContain('Made "Rain" (45 s, 82 bpm, D minor, seed 7).');
		expect(out.result).toContain(`![Rain](${URL})`);
		expect(out.artifacts).toEqual([{ kind: 'audio', mime: 'audio/mpeg', src: URL, title: 'Rain' }]);
	});

	it('makes the song with the seed asked for, so a follow-up can keep it', async () => {
		await executeTool('generate_music', { caption: 'x', seed: 1234 }, chat);
		expect(state.generate.mock.calls[0][0]).toMatchObject({ seed: 1234 });
	});

	it('refuses a path with no folder to save into, before making anything', async () => {
		const out = await executeTool('generate_music', { caption: 'x', path: 'a.mp3' }, chat);
		expect(out.result).toMatch(/no folder to save into/);
		expect(state.generate).not.toHaveBeenCalled();
	});

	it('in Chat with a working folder, saves the song there too', async () => {
		const withFolder = makeToolContext({
			interactive: true,
			conversationId: 'chat-1',
			workingDir: '/home/me/music'
		});
		const out = await executeTool('generate_music', { caption: 'x', path: 'rain.mp3' }, withFolder);
		// Chat checks for an existing file (and would ask) instead of a dry run.
		expect(state.invoke).toHaveBeenCalledWith('fs_path_exists', {
			workdir: '/home/me/music',
			relPath: 'rain.mp3'
		});
		const writes = state.invoke.mock.calls.filter(([c]) => String(c).startsWith('fs_write_bytes'));
		expect(writes).toHaveLength(1);
		expect(writes[0][1]).toMatchObject({
			workdir: '/home/me/music',
			relPath: 'rain.mp3',
			bytes: [9, 9],
			dryRun: false
		});
		expect(state.generate.mock.calls[0][1]).toMatchObject({ conversationId: 'chat-1' });
		expect(out.result).toContain('Wrote');
	});

	it('in a Code session, checks the path first, then writes the song there', async () => {
		const code = makeToolContext({
			interactive: true,
			codeSessionId: 'cs-1',
			workingDir: '/proj'
		});
		const out = await executeTool('generate_music', { caption: 'x', path: 'assets/bgm.mp3' }, code);
		const writes = state.invoke.mock.calls.filter(([c]) => String(c).startsWith('fs_write_bytes'));
		expect(writes.map(([, a]) => a.dryRun)).toEqual([true, false]);
		expect(writes[1][1].bytes).toEqual([9, 9]);
		expect(state.generate.mock.calls[0][1]).toMatchObject({ codeSessionId: 'cs-1' });
		expect(out.result).toContain('Wrote');
	});

	it('passes a cancel through, and turns a failure into a sentence', async () => {
		state.generate.mockRejectedValueOnce(new MusicBackendError('cancelled', 'Cancelled.'));
		await expect(executeTool('generate_music', { caption: 'x' }, chat)).rejects.toMatchObject({
			kind: 'cancelled'
		});
		state.generate.mockRejectedValueOnce(
			new MusicBackendError('unconfigured', 'ace-gpu2 is stopped — start it in llama-toolchest.')
		);
		const out = await executeTool('generate_music', { caption: 'x' }, chat);
		expect(out.result).toContain('Could not make it: ace-gpu2 is stopped');
	});

	it('is refused at run time with no backend', async () => {
		state.backend = 'none';
		const out = await executeTool('generate_music', { caption: 'x' }, chat);
		expect(out.result).toContain('Settings → Music');
	});
});
