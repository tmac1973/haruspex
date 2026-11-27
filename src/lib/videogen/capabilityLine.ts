/** One line on what a video model can do, for its row in Settings → Video generation. */

import { clipSeconds, longestClip } from '#lib/videogen/fit.ts';
import type { VideoCaps } from '#lib/videogen/types.ts';

/** "From a prompt or a picture · ends on a picture · up to 5 s at 1280×704", and its licence. */
export function videoCapabilityLine(caps: VideoCaps): { text: string; title?: string } {
	const from =
		caps.text && caps.startImage
			? 'From a prompt or a picture'
			: caps.startImage
				? 'From a picture'
				: 'From a prompt';
	const parts = [from];
	if (caps.endImage) parts.push('ends on a picture');
	if (caps.speech) parts.push(caps.needsSpeech ? 'speech only' : 'speech');
	if (caps.sound) parts.push('with sound');
	if (caps.references) parts.push('reference pictures');
	const most = longestClip(caps);
	parts.push(`up to ${clipSeconds(most.frames, most.fps)} s at ${most.width}×${most.height}`);
	const licence = caps.licence
		? `${caps.licence}${caps.commercialUse === false ? ' · not for commercial use' : caps.commercialUse ? ' · commercial use allowed' : ''}`
		: undefined;
	return { text: parts.join(' · '), ...(licence ? { title: licence } : {}) };
}
