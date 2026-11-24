import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('#lib/stores/notebooks.svelte.ts', () => ({ addCard: vi.fn() }));

import { fileMeta, formatSize, kindFor } from './files';
import type { NotebookCard } from '#lib/notebooks/api.ts';

const file = (mime: string) => ({ hash: 'a'.repeat(64), name: 'x', mime, size: 1 });

describe('notebook files', () => {
	it('makes pictures image cards and everything else attachments', () => {
		expect(kindFor(file('image/png'))).toBe('image');
		expect(kindFor(file('image/jpeg'))).toBe('image');
		expect(kindFor(file('application/pdf'))).toBe('attachment');
		expect(kindFor(file('image/tiff'))).toBe('attachment');
	});

	it('reads a file card meta and rejects a broken one', () => {
		const card = { meta: JSON.stringify(file('application/pdf')) } as NotebookCard;
		expect(fileMeta(card)?.mime).toBe('application/pdf');
		expect(fileMeta({ meta: '{}' } as NotebookCard)).toBeNull();
	});

	it('formats sizes', () => {
		expect(formatSize(500)).toBe('500 B');
		expect(formatSize(2048)).toBe('2 KB');
		expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
	});
});
