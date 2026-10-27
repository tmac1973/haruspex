/**
 * What the model is told about a picture it made: the tools' answers, and the
 * notice turn a background task's picture arrives in, word for word the same.
 * No tool registers here, so the notice text can import it.
 */

/**
 * The line telling the model where the picture goes. It also says the picture
 * is the answer: one of a fox otherwise reads as an answer about foxes, and
 * the model goes off to search for photos to put beside it.
 */
export function placeLine(markdown: string): string {
	return `Put ${markdown} in your answer where it belongs; it needs no other images.`;
}

/** The line saying a picture was saved, or why it wasn't. */
export function savedLineOf(path: string, failed: string | null): string {
	return failed ? `It is in the chat, but ${failed}` : `Wrote ${path}.`;
}

/** A drawn or edited picture's answer. */
export function imageAnswerText(a: {
	verb: string;
	width: number;
	height: number;
	model: string;
	seed: number;
	markdown: string;
	/** The model can see it: it is attached. */
	sees: boolean;
	saved: string | null;
	notes: string[];
}): string {
	return [
		`${a.verb} (${a.width}×${a.height}, ${a.model}, seed ${a.seed}).`,
		placeLine(a.markdown),
		...(a.sees
			? [
					'The picture is attached: look at it before you answer, and describe what it ' +
						'shows, not what was asked for.'
				]
			: []),
		...(a.saved ? [a.saved] : []),
		...a.notes
	].join(' ');
}

/** An upscaled picture's answer. */
export function upscaleAnswerText(a: {
	width: number;
	height: number;
	url: string;
	saved: string | null;
	note?: string;
}): string {
	return [
		`Upscaled to ${a.width}×${a.height}.`,
		placeLine(`![upscaled picture](${a.url})`),
		...(a.saved ? [a.saved] : []),
		...(a.note ? [a.note] : [])
	].join(' ');
}
