import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installMarkdownActions } from './markdown-actions';

function mountCodeBlock(action: string): HTMLButtonElement {
	document.body.innerHTML = `
		<div class="code-block">
			<div class="code-header">
				<button class="copy-btn" data-action="${action}">Copy</button>
			</div>
			<pre><code>echo hello</code></pre>
		</div>`;
	return document.querySelector('button')!;
}

describe('markdown action delegation', () => {
	let uninstall: () => void;

	beforeEach(() => {
		uninstall = installMarkdownActions();
	});

	afterEach(() => {
		uninstall();
		document.body.innerHTML = '';
	});

	it('copy writes the sibling code text to the clipboard', () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		mountCodeBlock('copy').click();
		expect(writeText).toHaveBeenCalledWith('echo hello');
	});

	it('shell-paste dispatches hsp-shell-paste with the command', () => {
		const seen = vi.fn();
		document.addEventListener('hsp-shell-paste', seen as EventListener, { once: true });
		mountCodeBlock('shell-paste').click();
		expect(seen).toHaveBeenCalledOnce();
		expect((seen.mock.calls[0][0] as CustomEvent).detail).toBe('echo hello');
	});

	it('shell-run dispatches hsp-shell-run with the command', () => {
		const seen = vi.fn();
		document.addEventListener('hsp-shell-run', seen as EventListener, { once: true });
		mountCodeBlock('shell-run').click();
		expect(seen).toHaveBeenCalledOnce();
		expect((seen.mock.calls[0][0] as CustomEvent).detail).toBe('echo hello');
	});

	it('uninstall removes the listener', () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		uninstall();
		mountCodeBlock('copy').click();
		expect(writeText).not.toHaveBeenCalled();
		uninstall = installMarkdownActions();
	});
});
