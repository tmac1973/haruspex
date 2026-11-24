import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { documentBlock, MAX_DOC_CHARS, readerFor, splitPath } from './droppedFiles';

describe('dropped documents', () => {
	it('picks a reader by extension', () => {
		expect(readerFor('Report.PDF')).toBe('pdf');
		expect(readerFor('a.docx')).toBe('docx');
		expect(readerFor('prices.xlsx')).toBe('xlsx');
		expect(readerFor('notes.md')).toBe('text');
		expect(readerFor('photo.png')).toBeNull();
	});

	it('splits Unix and Windows paths', () => {
		expect(splitPath('/home/u/doc.pdf')).toEqual({ dir: '/home/u', name: 'doc.pdf' });
		expect(splitPath('C:\\Users\\u\\doc.pdf')).toEqual({ dir: 'C:\\Users\\u', name: 'doc.pdf' });
		expect(splitPath('/doc.pdf')).toEqual({ dir: '/', name: 'doc.pdf' });
	});

	it('names the file and hash, and cuts long text', () => {
		const file = { hash: 'a'.repeat(64), name: 'prices.pdf', mime: 'application/pdf', size: 1 };
		const block = documentBlock(file, 'x'.repeat(MAX_DOC_CHARS + 10));
		expect(block).toContain(`prices.pdf (file: ${'a'.repeat(64)})`);
		expect(block).toContain('(cut off here)');
	});
});
