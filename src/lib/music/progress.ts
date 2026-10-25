import type { MusicProgress } from '#lib/music/types.ts';

/**
 * One line for a song in flight, shared by Settings → Music and the tool so
 * both say the same thing. `seconds` keeps moving so a long synthesis does not
 * look hung.
 */
export function describeMusicProgress(p: MusicProgress | null, seconds: number): string {
	const what = !p
		? 'Generating'
		: p.phase === 'queued' && p.ahead
			? `Queued (${p.ahead} ahead)`
			: {
					queued: 'Queued',
					running: 'Generating',
					composing: 'Composing',
					synthesizing: 'Synthesizing',
					saving: 'Saving'
				}[p.phase];
	return `${what}… ${seconds} s`;
}
