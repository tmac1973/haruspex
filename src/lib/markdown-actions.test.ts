import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installMarkdownActions, VIEW_IMAGE_EVENT } from './markdown-actions';

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

describe('view-image action', () => {
	let uninstall: () => void;

	beforeEach(() => {
		uninstall = installMarkdownActions();
	});

	afterEach(() => {
		uninstall();
		document.body.innerHTML = '';
	});

	it('dispatches the viewer event with the image inside the wrapper', () => {
		const seen = vi.fn();
		document.addEventListener(VIEW_IMAGE_EVENT, seen as EventListener, { once: true });
		document.body.innerHTML = `
			<figure class="chat-image">
				<button type="button" data-action="view-image">
					<img src="haruspex-img://localhost/abc" alt="a red panda">
				</button>
			</figure>`;
		document.querySelector('img')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(seen).toHaveBeenCalledTimes(1);
		const detail = (seen.mock.calls[0][0] as CustomEvent).detail;
		expect(detail.src).toContain('abc');
		expect(detail.alt).toBe('a red panda');
	});

	it('fires when the button itself is clicked, not just the image', () => {
		const seen = vi.fn();
		document.addEventListener(VIEW_IMAGE_EVENT, seen as EventListener, { once: true });
		document.body.innerHTML = `
			<button type="button" data-action="view-image">
				<img src="haruspex-img://localhost/def" alt="x">
			</button>`;
		document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('ignores a click on an ordinary image', () => {
		const seen = vi.fn();
		document.addEventListener(VIEW_IMAGE_EVENT, seen as EventListener, { once: true });
		document.body.innerHTML = `<img src="haruspex-img://localhost/ghi" alt="x">`;
		document.querySelector('img')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(seen).not.toHaveBeenCalled();
	});

	// The zoom wrapper is matched first; the copy/paste/run buttons must still
	// work exactly as before.
	it('leaves the existing code-block actions alone', () => {
		const seen = vi.fn();
		document.addEventListener('hsp-shell-run', seen as EventListener, { once: true });
		document.body.innerHTML = `
			<div class="code-block"><code>ls -la</code>
				<button data-action="shell-run">Run</button>
			</div>`;
		document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(seen).toHaveBeenCalledTimes(1);
		expect((seen.mock.calls[0][0] as CustomEvent).detail).toBe('ls -la');
	});
});
