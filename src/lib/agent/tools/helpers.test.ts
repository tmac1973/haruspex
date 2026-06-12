import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('') }));
vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({ proxy: { mode: 'none', url: '', bypass: '' } }),
	hasEnabledEmailAccount: () => false
}));

import { ensureUrlScheme, isToolErrorResult } from './_helpers';
import { toolError } from './types';

describe('isToolErrorResult', () => {
	it('detects the toolError JSON envelope', () => {
		expect(isToolErrorResult(toolError('fs_write_pptx failed: boom'))).toBe(true);
		expect(isToolErrorResult('{"error":"Parent directory does not exist"}')).toBe(true);
	});

	it('detects Error: and lint-failure prefixes', () => {
		expect(isToolErrorResult('Error: NameError: x is not defined')).toBe(true);
		expect(isToolErrorResult('Lint failed before running (ruff caught 1 issue)...')).toBe(true);
	});

	it('detects fetch failure prefixes', () => {
		expect(isToolErrorResult('Failed to fetch https://x: timeout')).toBe(true);
		expect(isToolErrorResult('Paywalled: subscription required')).toBe(true);
	});

	it('does not flag successful results', () => {
		expect(isToolErrorResult('Wrote: deck.pptx')).toBe(false);
		expect(isToolErrorResult('{"images":[]}')).toBe(false);
		expect(isToolErrorResult('Stdout:\nhello')).toBe(false);
		expect(isToolErrorResult(undefined)).toBe(false);
		expect(isToolErrorResult('')).toBe(false);
	});

	it('does not flag prose that merely mentions errors', () => {
		expect(isToolErrorResult('The page discusses Error: handling in Rust')).toBe(false);
	});
});

describe('ensureUrlScheme', () => {
	it('prepends https:// to scheme-less host URLs', () => {
		expect(ensureUrlScheme('example.com/page')).toBe('https://example.com/page');
		expect(ensureUrlScheme('www.nytimes.com/2026/01/01/x.html')).toBe(
			'https://www.nytimes.com/2026/01/01/x.html'
		);
		expect(ensureUrlScheme('sub.domain.co.uk')).toBe('https://sub.domain.co.uk');
	});

	it('leaves URLs with a scheme untouched', () => {
		expect(ensureUrlScheme('https://example.com')).toBe('https://example.com');
		expect(ensureUrlScheme('http://localhost:8080/x')).toBe('http://localhost:8080/x');
	});

	it('leaves non-URL-shaped strings untouched', () => {
		expect(ensureUrlScheme('not a url')).toBe('not a url');
		expect(ensureUrlScheme('filename.txt')).toBe('https://filename.txt'); // host-shaped — backend rejects
		expect(ensureUrlScheme('')).toBe('');
	});
});

describe('unknown-tool nearest-match hint', () => {
	it('suggests the closest registered tool name', async () => {
		// Side-effect import registers the email tools in the shared registry.
		await import('./email');
		const { executeTool } = await import('./registry');
		const out = await executeTool('email_list_recents', {}, {
			workingDir: null,
			shellMode: false
		} as never);
		expect(out.result).toContain('Unknown tool: email_list_recents');
		expect(out.result).toContain('Did you mean email_list_recent?');
	});

	it('stays silent when nothing is close', async () => {
		const { executeTool } = await import('./registry');
		const out = await executeTool('launch_rocket', {}, {
			workingDir: null,
			shellMode: false
		} as never);
		expect(out.result).toContain('Unknown tool: launch_rocket');
		expect(out.result).not.toContain('Did you mean');
	});
});
