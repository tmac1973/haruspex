import { describe, it, expect } from 'vitest';
import { stepLabel, stepIcon } from './searchStepLabels';

describe('stepLabel', () => {
	it('quotes the query for search tools', () => {
		expect(stepLabel('web_search', 'cats')).toBe('Searching: "cats"');
		expect(stepLabel('image_search', 'cats')).toBe('Searching images: "cats"');
	});

	it('uses the per-tool prefix for the rest', () => {
		expect(stepLabel('fetch_url', 'https://x')).toBe('Reading: https://x');
		expect(stepLabel('fs_write_pdf', 'r.pdf')).toBe('Writing pdf: r.pdf');
		expect(stepLabel('fs_read_xlsx', 'data.xlsx')).toBe('Reading xlsx: data.xlsx');
		expect(stepLabel('fs_edit_text', 'a.txt')).toBe('Editing: a.txt');
		expect(stepLabel('fetch_url_images', 'https://x')).toBe('Scanning page for images: https://x');
	});

	it('falls back to "<tool>: <query>" for unknown tools', () => {
		expect(stepLabel('mystery_tool', 'arg')).toBe('mystery_tool: arg');
	});
});

describe('stepIcon', () => {
	it('maps known tools to distinct icons', () => {
		expect(stepIcon('web_search')).toBe('\u{1F50D}');
		expect(stepIcon('research_url')).toBe('\u{1F9D0}');
	});

	it('matches fs_write / fs_list / fs_edit by prefix', () => {
		expect(stepIcon('fs_write_pdf')).toBe('\u{1F4DD}');
		expect(stepIcon('fs_list_dir')).toBe('\u{1F4C2}');
		expect(stepIcon('fs_edit_text')).toBe('✏️');
	});

	it('falls back to the generic document icon', () => {
		expect(stepIcon('mystery_tool')).toBe('\u{1F4C4}');
	});
});
