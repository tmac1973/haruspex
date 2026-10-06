import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import SearchStep from './SearchStep.svelte';
import type { SearchStep as Step } from '#lib/agent/loop.ts';
import type { Artifact } from '#lib/sandbox/protocol.ts';

// SearchStep pulls rerun/cancel actions from the chat store, whose module
// graph reaches Tauri IPC. Mock just the two functions the component uses.
const tauri = vi.hoisted(() => ({
	invoke: vi.fn(async (cmd: string) => (cmd === 'artifact_register' ? 'artifact-1' : null))
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

vi.mock('#lib/stores/chat.svelte.ts', () => ({
	rerunSandboxStep: vi.fn().mockResolvedValue(undefined),
	cancelActiveSandboxRun: vi.fn()
}));

function makeStep(artifacts: Artifact[], overrides: Partial<Step> = {}): Step {
	return {
		id: 'step-1',
		toolName: 'run_python',
		query: 'print("hi")',
		status: 'done',
		result: 'ok',
		artifacts,
		...overrides
	};
}

describe('SearchStep artifacts', () => {
	it('sanitization regression: strips onerror/onload handlers from plain HTML artifacts', () => {
		render(SearchStep, {
			steps: [
				makeStep([
					{
						kind: 'html',
						html: '<div><img src="x" onerror="window.__pwned = true"><svg onload="window.__pwned = true"></svg><p>safe text</p></div>'
					}
				])
			]
		});
		const container = document.querySelector('.artifact-html')!;
		expect(container).toBeTruthy();
		const html = container.innerHTML;
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('onload');
		// Legitimate content survives sanitization
		expect(container.textContent).toContain('safe text');
		expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
	});

	it('removes <script> tags from plain HTML artifacts', () => {
		render(SearchStep, {
			steps: [
				makeStep([{ kind: 'html', html: '<p>before</p><script>window.__pwned = true</script>' }])
			]
		});
		const html = document.querySelector('.artifact-html')!.innerHTML;
		expect(html).not.toContain('<script');
		expect(html).toContain('before');
		expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
	});

	it('renders interactive artifacts in a sandboxed iframe from their own scheme', async () => {
		const chartHtml = '<html><body><script>plot()</script></body></html>';
		render(SearchStep, {
			steps: [makeStep([{ kind: 'html', html: chartHtml, interactive: true }])]
		});
		const iframe = await waitFor(() => {
			const f = document.querySelector<HTMLIFrameElement>('iframe.artifact-iframe');
			if (!f) throw new Error('no iframe yet');
			return f;
		});
		// Served by Rust with a CSP of its own, never inlined with srcdoc: a
		// srcdoc document would inherit (and so loosen) the app's own policy.
		expect(tauri.invoke).toHaveBeenCalledWith('artifact_register', { html: chartHtml });
		expect(iframe.getAttribute('src')).toMatch(/haruspex-artifact.*\/artifact-1$/);
		expect(iframe.hasAttribute('srcdoc')).toBe(false);
		const sandbox = iframe.getAttribute('sandbox')!;
		expect(sandbox).toBe('allow-scripts');
		expect(sandbox).not.toContain('allow-same-origin');
		// The interactive branch must not also render the {@html} branch
		expect(document.querySelector('.artifact-html')).toBeNull();
	});

	it('renders image artifacts as an <img> with the dataUrl', () => {
		const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
		render(SearchStep, {
			steps: [makeStep([{ kind: 'image', mime: 'image/png', dataUrl, alt: 'a plot' }])]
		});
		const img = document.querySelector<HTMLImageElement>('img.artifact-image')!;
		expect(img).toBeTruthy();
		expect(img.getAttribute('src')).toBe(dataUrl);
		expect(img.getAttribute('alt')).toBe('a plot');
	});

	it('keeps legitimate table markup intact through sanitization', () => {
		const tableHtml =
			'<table><thead><tr><th>col</th></tr></thead><tbody><tr><td>42</td></tr></tbody></table>';
		render(SearchStep, {
			steps: [makeStep([{ kind: 'html', html: tableHtml, truncated: { shown: 1, total: 100 } }])]
		});
		const container = document.querySelector('.artifact-html')!;
		expect(container.querySelector('table')).toBeTruthy();
		expect(container.querySelector('th')?.textContent).toBe('col');
		expect(container.querySelector('td')?.textContent).toBe('42');
		// Truncation note renders alongside the table
		expect(screen.getByText('Showing 1 of 100 rows')).toBeTruthy();
	});

	it('renders nothing for an empty steps array', () => {
		render(SearchStep, { steps: [] });
		expect(document.querySelector('.search-steps')).toBeNull();
	});
});
