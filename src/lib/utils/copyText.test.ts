import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from './copyText.ts';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
	if (original) Object.defineProperty(navigator, 'clipboard', original);
	else Reflect.deleteProperty(navigator, 'clipboard');
	vi.restoreAllMocks();
});

describe('copyText', () => {
	it('uses the clipboard API when the page has it', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await copyText('hello');
		expect(writeText).toHaveBeenCalledWith('hello');
	});

	it('falls back to a selected textarea on a plain-HTTP page', async () => {
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
		let copied = '';
		document.execCommand = vi.fn(() => {
			copied = document.querySelector('textarea')?.value ?? '';
			return true;
		});
		await copyText('over http');
		expect(copied).toBe('over http');
		expect(document.querySelector('textarea')).toBeNull();
	});

	it('says so when neither works', async () => {
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
		document.execCommand = vi.fn(() => false);
		await expect(copyText('x')).rejects.toThrow('refused');
	});
});
