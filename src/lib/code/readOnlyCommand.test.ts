import { describe, it, expect } from 'vitest';
import { isReadOnlyCommand } from './readOnlyCommand';

describe('isReadOnlyCommand', () => {
	it.each([
		'ls -la',
		'cat README.md | head -20',
		'git status --porcelain',
		'git -C sub log --oneline -5',
		'git diff HEAD~1 -- src',
		'git branch -a',
		'grep -rn foo src 2>/dev/null',
		'rg foo && wc -l a.ts',
		'find . -name "*.ts"',
		'FOO=1 ls',
		'echo hi 2>&1'
	])('reads: %s', (cmd) => {
		expect(isReadOnlyCommand(cmd)).toBe(true);
	});

	it.each([
		'npm install',
		'cargo build',
		'echo x > a.txt',
		'cat a >> b',
		'ls; rm -rf build',
		'find . -name "*.o" -delete',
		'find . -exec rm {} ;',
		'git checkout main',
		'git branch new-thing',
		'git tag v1',
		'sort -o out.txt in.txt',
		'ls $(touch x)',
		'sed -i s/a/b/ f',
		'./script.sh'
	])('may write: %s', (cmd) => {
		expect(isReadOnlyCommand(cmd)).toBe(false);
	});
});
