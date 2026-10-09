import type { ImageProgress } from './types';

/**
 * One line for a generation in flight, shared by Settings → Image and the
 * chat tool so both say the same thing. `seconds` is time since the request
 * started: a cold ComfyUI can spend a minute loading before its first step,
 * and a counter that keeps moving is what tells the user it has not hung.
 */
export function describeImageProgress(p: ImageProgress | null, seconds: number): string {
	const what = !p
		? 'Drawing'
		: p.step && p.totalSteps
			? `Drawing, step ${p.step} of ${p.totalSteps}`
			: (p.detail ??
				{
					queued: 'Queued',
					loading: 'Loading the model',
					running: 'Drawing',
					downloading: 'Fetching the image'
				}[p.phase]);
	return `${what}… ${seconds} s`;
}
