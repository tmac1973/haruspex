/**
 * `voice_from_clip`: save a saved voice (`voices.rs`) from a stretch of a
 * recording in the working folder, for a llama.cpp speech server to speak
 * in. The model picks 10–20 s of one person speaking, without music, from
 * `video_transcribe`'s or `transcribe_audio`'s word times. Nothing is saved
 * until the person at the keyboard answers the question, with the warning,
 * that it is their voice or one they have permission to use.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { waitOnUser } from '#lib/agent/tools/_helpers.ts';
import { parseTime } from '#lib/video/args.ts';
import { formatTime } from '#lib/video/report.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { refreshSavedVoices } from '#lib/audio/savedVoices.ts';
import { VOICE_CONSENT_WARNING, VOICE_CONSENT_YES } from '#lib/audio/voiceConsent.ts';
import type { SavedVoice } from '#lib/ipc/gen/SavedVoice.ts';
import { trimmedOrNull } from '#lib/utils/coerce.ts';

const CANCEL = 'Cancel';

interface ClipArgs {
	path: string;
	from: number;
	to: number;
	name: string;
}

/** The arguments, or what is wrong with them. */
export function parseClipArgs(args: Record<string, unknown>): ClipArgs | string {
	const path = trimmedOrNull(args.path);
	const name = trimmedOrNull(args.name);
	const from = parseTime(args.from);
	const to = parseTime(args.to);
	if (!path || !name || from === null || to === null) {
		return 'voice_from_clip needs "path", "from", "to" and "name".';
	}
	const secs = to - from;
	if (secs < 5 || secs > 30) {
		return `The stretch is ${secs.toFixed(1)} s; pick 5–30 s (10–20 s is best) of one person speaking.`;
	}
	return { path, from, to, name };
}

async function confirmed(a: ClipArgs, ctx: ToolContext): Promise<boolean> {
	const question = `Save the voice in ${a.path}, ${formatTime(a.from)}–${formatTime(a.to)}, as "${a.name}"?`;
	const options = [{ label: VOICE_CONSENT_YES }, { label: CANCEL }];
	// Another route to a person (a remote guest) shows the question alone, so
	// the warning goes in it; this window's modal shows it under it.
	const request = ctx.askUser
		? { question: `${question} ${VOICE_CONSENT_WARNING}`, options }
		: {
				question,
				body: VOICE_CONSENT_WARNING,
				options,
				...(ctx.codeSessionId ? { sessionId: ctx.codeSessionId } : {})
			};
	const ask = ctx.askUser ?? (await import('#lib/stores/userQuestion.svelte.ts')).askUserQuestion;
	const answer = await waitOnUser(ctx, () => ask(request, ctx.signal));
	return answer.kind === 'selected' && answer.labels[0] === VOICE_CONSENT_YES;
}

async function execute(args: Record<string, unknown>, ctx: ToolContext) {
	const parsed = parseClipArgs(args);
	if (typeof parsed === 'string') return toolResult(toolError(parsed));
	if (!ctx.askUser && !ctx.interactive) {
		return toolResult(toolError('Saving a voice needs someone here to confirm it.'));
	}
	if (!(await confirmed(parsed, ctx))) {
		return toolResult('Not saved: the user did not confirm it is their voice or one they may use.');
	}
	try {
		const voice = await invoke<SavedVoice>('voice_add_clip', {
			workingDir: ctx.workingDir,
			path: parsed.path,
			fromSecs: parsed.from,
			toSecs: parsed.to,
			name: parsed.name,
			consent: true,
			overrides: videoOverrides()
		});
		void refreshSavedVoices();
		const says = voice.refText ? ` It says: "${voice.refText}"` : '';
		return toolResult(
			`Saved the voice "${voice.name}" (${voice.secs.toFixed(1)} s).${says} generate_speech speaks in it with voice: "${voice.name}" when Settings → Audio → Speech engine is a llama.cpp server. Settings → Audio → Saved voices corrects what it says.`
		);
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'voice_from_clip',
			description:
				'Save a voice from a stretch of a recording in the working folder, for generate_speech to speak in. Pick 10–20 s of one person speaking with no music, from the word times of video_transcribe or transcribe_audio. The user is asked to confirm it is their voice or one they may use.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The file, relative to the working folder.' },
					from: { type: 'string', description: 'Where the speech starts, e.g. "0:41.20".' },
					to: { type: 'string', description: 'Where it ends.' },
					name: { type: 'string', description: 'What to call the voice, e.g. "Tim".' }
				},
				required: ['path', 'from', 'to', 'name']
			}
		}
	},
	displayLabel: (args) => `Saving a voice from ${trimmedOrNull(args.path) ?? 'a clip'}`,
	execute
});
