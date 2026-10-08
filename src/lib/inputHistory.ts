/**
 * Up and Down through the messages already sent in this conversation, in the
 * Chat and Shell input boxes, the way a shell's history works.
 *
 * Up recalls only while the caret is on the box's first line, and Down only
 * on its last, so moving around a multi-line message still works. Whatever
 * was typed before the first Up comes back after the newest message.
 */

/** The messages to step through, oldest first: blanks dropped, repeats once. */
export function sentHistory(texts: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of texts) {
		const text = raw.trim();
		if (text && text !== out.at(-1)) out.push(text);
	}
	return out;
}

/** The caret, with nothing selected, is on the first line of `el`. */
export function caretOnFirstLine(el: HTMLTextAreaElement): boolean {
	return (
		el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes('\n')
	);
}

/** The caret, with nothing selected, is on the last line of `el`. */
export function caretOnLastLine(el: HTMLTextAreaElement): boolean {
	return el.selectionStart === el.selectionEnd && !el.value.slice(el.selectionEnd).includes('\n');
}

/** What a handled key does to the box: its new text, and where the caret goes. */
export interface Recall {
	text: string;
	/** Start, so the next Up keeps going back; end, so the next Down keeps going forward. */
	caret: 'start' | 'end';
}

export class InputHistory {
	/** Where we are in `entries()` while browsing; null when not browsing. */
	private index: number | null = null;
	/** The text in the box before browsing began. */
	private draft = '';

	constructor(private readonly entries: () => string[]) {}

	/**
	 * Handle `e` in the box `el`: a Recall when it was Up or Down and moved
	 * through the history (the caller sets the text, and should
	 * `preventDefault`), else null and the key does what it normally does.
	 */
	key(e: KeyboardEvent, el: HTMLTextAreaElement): Recall | null {
		if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return null;
		const list = this.entries();
		if (this.index !== null && this.index >= list.length) this.reset();
		if (e.key === 'ArrowUp' && caretOnFirstLine(el)) return this.back(list, el.value);
		if (e.key === 'ArrowDown' && caretOnLastLine(el)) return this.forward(list);
		return null;
	}

	private back(list: string[], current: string): Recall | null {
		if (this.index === null) {
			if (list.length === 0) return null;
			this.draft = current;
			this.index = list.length - 1;
		} else if (this.index > 0) {
			this.index--;
		} else {
			return null;
		}
		return { text: list[this.index], caret: 'start' };
	}

	private forward(list: string[]): Recall | null {
		if (this.index === null) return null;
		this.index++;
		if (this.index >= list.length) {
			this.index = null;
			return { text: this.draft, caret: 'end' };
		}
		return { text: list[this.index], caret: 'end' };
	}

	/** Stop browsing: after a send, or when the conversation changes. */
	reset(): void {
		this.index = null;
		this.draft = '';
	}
}

/** Put the caret where a Recall says, once the box shows its new text. */
export function placeCaret(el: HTMLTextAreaElement, caret: Recall['caret']): void {
	const at = caret === 'start' ? 0 : el.value.length;
	el.setSelectionRange(at, at);
}
