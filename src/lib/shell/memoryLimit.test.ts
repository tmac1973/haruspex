import { describe, it, expect } from 'vitest';
import { outOfMemoryNote } from './memoryLimit';

describe('outOfMemoryNote', () => {
	it('says nothing for a command that stayed under the limit', () => {
		expect(outOfMemoryNote({ out_of_memory: false, memory_limit_mb: 1024 })).toBeNull();
	});

	it('names the limit and says not to re-run unchanged', () => {
		const note = outOfMemoryNote({ out_of_memory: true, memory_limit_mb: 30720 });
		expect(note).toContain('its 30.0 GB memory limit');
		expect(note).toContain('do not re-run it unchanged');
	});

	it('copes without a known limit', () => {
		expect(outOfMemoryNote({ out_of_memory: true, memory_limit_mb: null })).toContain(
			'went over its memory limit'
		);
	});
});
