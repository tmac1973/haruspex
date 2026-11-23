import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke, Channel: class {} }));

vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { videoEditingEnabled: true },
		overDefaults: true
	})
);

import { executeTool } from '#lib/agent/tools/index.ts';
import { parseClipArgs } from './voice-from-clip';
import { VOICE_CONSENT_WARNING, VOICE_CONSENT_YES } from '#lib/audio/voiceConsent.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import type { UserAnswer, UserQuestionRequest } from '#lib/agent/tools/types.ts';

const args = { path: 'ep012/raw/cam.mp4', from: '0:41.2', to: '0:55', name: 'Tim' };
const saved = {
	id: 'tim-abc123',
	name: 'Tim',
	source: 'clip',
	sourcePath: '/videos/ep012/raw/cam.mp4',
	fromSecs: 41.2,
	toSecs: 55,
	refText: 'So today we build it.',
	secs: 13.8,
	consentedAt: 1
};

function ctxAnswering(label: string) {
	const askUser = vi.fn<(q: UserQuestionRequest) => Promise<UserAnswer>>(async () => ({
		kind: 'selected',
		labels: [label]
	}));
	return { askUser, ctx: makeToolContext({ interactive: true, workingDir: '/videos', askUser }) };
}

const found = { path: '/usr/bin/x', version: 'x', source: 'path' as const };

beforeEach(() => {
	_setVideoBinariesForTests({ ffmpeg: found, ffprobe: found, melt: found, hints: [] });
	state.invoke.mockReset();
	state.invoke.mockImplementation(invokeRouter({ voice_add_clip: saved, voices_list: [] }, true));
});

describe('voice_from_clip', () => {
	it('asks with the warning, and does nothing on Cancel', async () => {
		const { askUser, ctx } = ctxAnswering('Cancel');
		const out = await executeTool('voice_from_clip', args, ctx);
		const q = askUser.mock.calls[0][0];
		expect(q.question).toContain('ep012/raw/cam.mp4, 0:41.2–0:55.0');
		expect(q.question).toContain(VOICE_CONSENT_WARNING);
		expect(q.options.map((o) => o.label)).toEqual([VOICE_CONSENT_YES, 'Cancel']);
		expect(out.result).toContain('Not saved');
		expect(state.invoke).not.toHaveBeenCalledWith('voice_add_clip', expect.anything());
	});

	it('saves it on the first answer, with consent', async () => {
		const { ctx } = ctxAnswering(VOICE_CONSENT_YES);
		const out = await executeTool('voice_from_clip', args, ctx);
		expect(state.invoke).toHaveBeenCalledWith(
			'voice_add_clip',
			expect.objectContaining({
				workingDir: '/videos',
				path: 'ep012/raw/cam.mp4',
				fromSecs: 41.2,
				toSecs: 55,
				name: 'Tim',
				consent: true
			})
		);
		expect(out.result).toContain(
			'Saved the voice "Tim" (13.8 s). It says: "So today we build it."'
		);
	});

	it('refuses a stretch under 5 or over 30 seconds before asking', () => {
		expect(parseClipArgs({ ...args, to: '0:43' })).toContain('pick 5–30 s');
		expect(parseClipArgs({ ...args, to: '1:20' })).toContain('pick 5–30 s');
		expect(parseClipArgs({ path: 'a.wav' })).toContain('needs "path"');
	});
});
