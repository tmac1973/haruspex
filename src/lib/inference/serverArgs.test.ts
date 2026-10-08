import { describe, it, expect } from 'vitest';
import { splitServerArgs } from './serverArgs.ts';

describe('splitServerArgs', () => {
	it('splits on any whitespace', () => {
		expect(splitServerArgs('  --n-cpu-moe 10\t--threads  8\n')).toEqual([
			'--n-cpu-moe',
			'10',
			'--threads',
			'8'
		]);
	});

	it('is empty for an empty or blank setting', () => {
		expect(splitServerArgs('')).toEqual([]);
		expect(splitServerArgs('   ')).toEqual([]);
	});

	it('groups quoted text and drops the quotes', () => {
		expect(splitServerArgs(`--alias "my model" --x 'a b'`)).toEqual([
			'--alias',
			'my model',
			'--x',
			'a b'
		]);
	});

	it('keeps backslashes in an override-tensor regex', () => {
		expect(splitServerArgs('-ot "blk\\.(1|2)\\.ffn_.*_exps=CPU"')).toEqual([
			'-ot',
			'blk\\.(1|2)\\.ffn_.*_exps=CPU'
		]);
	});

	it('keeps an empty quoted argument', () => {
		expect(splitServerArgs(`--chat-template-kwargs ''`)).toEqual(['--chat-template-kwargs', '']);
	});
});
