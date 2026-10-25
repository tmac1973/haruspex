/**
 * One player at a time. Starting any `<audio>` pauses every other one in the
 * document, and `onPlay` runs too (the desktop stops read-aloud there, so a
 * song and a spoken reply never talk over each other).
 *
 * One listener on the document, in the capture phase because `play` does not
 * bubble, so it covers players in answers (plain HTML from markdown) and
 * players in components alike.
 */
export function installAudioExclusivity(doc: Document, onPlay?: () => void): () => void {
	const handler = (e: Event) => {
		const started = e.target;
		if (!(started instanceof HTMLAudioElement)) return;
		for (const other of doc.querySelectorAll('audio')) {
			if (other !== started && !other.paused) other.pause();
		}
		onPlay?.();
	};
	doc.addEventListener('play', handler, true);
	return () => doc.removeEventListener('play', handler, true);
}
