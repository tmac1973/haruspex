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

	describe('reasoning', () => {
		/**
		 * Reasoning used to be a <details> baked into the HTML string, which
		 * meant an in-progress block — no closing tag yet — rendered as nothing
		 * at all. A live turn showed an empty bubble while the model thought.
		 */
		it('renders an unclosed think block as a live panel', () => {
			render(ChatMessage, {
				message: { role: 'assistant', content: '<think>weighing the options' },
				isStreaming: true
			});
			expect(screen.getByText('Thinking…')).toBeTruthy();
			expect(screen.getByText(/weighing the options/)).toBeTruthy();
		});

		it('renders reasoning and answer as separate pieces', () => {
			render(ChatMessage, {
				message: { role: 'assistant', content: '<think>considered it</think>**Answer**' }
			});
			expect(screen.getByText('Reasoning')).toBeTruthy();
			expect(screen.getByText(/considered it/)).toBeTruthy();
			expect(document.querySelector('.message-content strong')?.textContent).toBe('Answer');
		});

		/**
		 * Qwen sometimes wraps a whole response in <think> and emits EOS. The
		 * thinking IS the answer there — promoting it is what stops the message
		 * rendering as an empty bubble with a disclosure hanging off it.
		 */
		it('promotes a thinking-only finished message to prose', () => {
			render(ChatMessage, {
				message: { role: 'assistant', content: '<think>**the whole answer**</think>' }
			});
			expect(screen.queryByText('Reasoning')).toBeNull();
			expect(document.querySelector('.message-content strong')?.textContent).toBe(
				'the whole answer'
			);
		});

		it('renders no panel for a message that never reasoned', () => {
			render(ChatMessage, { message: { role: 'assistant', content: 'just an answer' } });
			expect(screen.queryByText('Reasoning')).toBeNull();
			expect(screen.queryByText('Thinking…')).toBeNull();
		});
	});
});
