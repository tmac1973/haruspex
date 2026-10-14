import { describe, it, expect } from 'vitest';
import { detectIndent } from './indent';

describe('detectIndent', () => {
	it('keeps tabs in a tab-indented file, block comments and all', () => {
		const ts = '/**\n * Doc.\n */\nfunction f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n';
		expect(detectIndent(ts)).toBe('\t');
	});

	it('finds the step a space-indented file nests by', () => {
		const py = 'def f(x):\n    if x:\n        return 1\n    return 2\n';
		expect(detectIndent(py)).toBe('    ');
		const yaml = 'a:\n  b:\n    c: 1\n  d: 2\n';
		expect(detectIndent(yaml)).toBe('  ');
	});

	it('follows the majority when a file mixes them', () => {
		expect(detectIndent('a\n\tb\n\tc\n    d\n')).toBe('\t');
		expect(detectIndent('a\n    b\n    c\n\td\n')).toBe('    ');
	});

	it('has no answer for a file with nothing indented', () => {
		expect(detectIndent('')).toBeNull();
		expect(detectIndent('# Title\n\nText.\n')).toBeNull();
	});
});
