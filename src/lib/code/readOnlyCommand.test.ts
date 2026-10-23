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
		'echo hi 2>&1',
		'ls &>/dev/null',
		'cd /p/lantern && git status --short && git log --oneline -3',
		`grep -n "" src/game.ts | sed -n '110,180p'`,
		`sed -n '/start/,/end/p' a.txt`,
		"sed -e 's/a/b/g' -e '3d' a.txt",
		"sed -E 's|/usr|/opt|2' a.txt",
		'sed -n "1~2{p;=}" a.txt',
		'for f in src/*.test.ts; do echo "== $f"; grep -nE "^\\s*it(\\.each)?\\(" "$f" | wc -l; done',
		'if [ -f a ]; then cat a; fi',
		'while read l; do echo "$l"; done',
		'grep -E "FAIL|Error" log.txt | head -40',
		"grep -n '=>' src/a.ts",
		"echo '$(not run)'",
		'find . -name "*.ts" | xargs grep -l foo',
		'git ls-files | xargs -n 1 wc -l',
		'(cd sub && ls)'
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
		'sed -ni p f',
		'sed --in-place s/a/b/ f',
		'sed -f script.sed f',
		"sed 's/a/b/w out.txt' f",
		"sed 's/a/date/e' f",
		"sed -n '1w out.txt' f",
		"sed '1e touch x' f",
		"sed 'r other.txt' f",
		'./script.sh',
		'CI=1 npx vitest run --reporter=dot 2>&1 | tail -20',
		'npm test 2>&1 | tail -40',
		'cd sub && npm install',
		'echo hi 1>out.txt',
		'echo "$(touch x)"',
		'cat `touch x`',
		'diff <(ls a) <(ls b)',
		'find . | xargs rm',
		'for f in *.o; do rm "$f"; done',
		'if true; then git checkout main; fi',
		"echo 'unclosed"
	])('may write: %s', (cmd) => {
		expect(isReadOnlyCommand(cmd)).toBe(false);
	});
});
