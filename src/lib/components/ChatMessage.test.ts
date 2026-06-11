import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ChatMessage from './ChatMessage.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));

describe('ChatMessage', () => {
	it('renders user messages as escaped plain text', () => {
		render(ChatMessage, {
			message: { role: 'user', content: '<img src=x onerror="alert(1)"> hello' }
		});
		// The payload must appear as literal text, not become an element
		expect(screen.getByText(/hello/)).toBeTruthy();
		expect(document.querySelector('.message-content img')).toBeNull();
	});

	it('renders assistant markdown as HTML', () => {
		render(ChatMessage, {
			message: { role: 'assistant', content: '**bold** and `code`' }
		});
		const content = document.querySelector('.message-content')!;
		expect(content.querySelector('strong')?.textContent).toBe('bold');
		expect(content.querySelector('code')?.textContent).toBe('code');
	});

	it('XSS regression: assistant HTML payloads are sanitized before {@html}', () => {
		render(ChatMessage, {
			message: {
				role: 'assistant',
				content:
					'hi <img src=x onerror="alert(1)"> there\n\n<script>window.__pwned = true</script>\n\n[link](javascript:alert(1))'
			}
		});
		const html = document.querySelector('.message-content')!.innerHTML;
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('javascript:');
		expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
	});

	it('labels user and assistant messages', () => {
		render(ChatMessage, { message: { role: 'user', content: 'q' } });
		expect(screen.getByText('You')).toBeTruthy();
		render(ChatMessage, { message: { role: 'assistant', content: 'a' } });
		expect(screen.getByText('Haruspex')).toBeTruthy();
	});

	it('shows the tok/s footer only when a positive rate is given', () => {
		render(ChatMessage, {
			message: { role: 'assistant', content: 'x' },
			tokensPerSecond: 42.4
		});
		expect(screen.getByText('42 tok/s')).toBeTruthy();
	});
});
