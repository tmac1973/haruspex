import { describe, it, expect } from 'vitest';
import { checkBoundary } from './boundary';
import type { ProtectedTargets } from '$lib/ipc/gen/ProtectedTargets';

const linux: ProtectedTargets = {
	home: '/home/tim',
	paths: [
		{ path: '/home/tim/.local/share/com.haruspex.app/', label: 'data directory' },
		{ path: '/home/tim/Projects/haruspex/', label: 'source tree' }
	],
	ports: [
		{ port: 8765, label: 'chat model server' },
		{ port: 8767, label: 'image engine' },
		{ port: 8188, label: 'image backend' }
	]
};

const check = (cmd: string, root: string | null = '/home/tim/Projects/game') =>
	checkBoundary(cmd, linux, root);

describe('checkBoundary', () => {
	it('catches the database, however home is spelled', () => {
		for (const cmd of [
			'sqlite3 ~/.local/share/com.haruspex.app/haruspex.db .tables',
			'cat $HOME/.local/share/com.haruspex.app/settings.json',
			'cat "${HOME}/.local/share/com.haruspex.app/x"',
			'ls /home/tim/.local/share/com.haruspex.app'
		]) {
			expect(check(cmd).reasons, cmd).toEqual(["touches Haruspex's data directory"]);
		}
	});

	it("catches Haruspex's own services on loopback", () => {
		expect(check('curl http://127.0.0.1:8767/sdapi/v1/txt2img').reasons).toEqual([
			"calls Haruspex's image engine (port 8767)"
		]);
		expect(check('curl -s localhost:8188/prompt').matched).toBe(true);
		expect(check('nc localhost 8765').matched).toBe(true);
		expect(check('curl http://[::1]:8765/health').matched).toBe(true);
	});

	it("leaves the project's own work alone", () => {
		for (const cmd of [
			'npm run dev -- --port 5173',
			'curl localhost:5173',
			'ls src',
			'cargo test',
			'cat ~/.bashrc',
			'python3 -m http.server 8000'
		]) {
			expect(check(cmd).matched, cmd).toBe(false);
		}
	});

	it("allows Haruspex's own source when that is the project", () => {
		expect(check('cat src/lib/x.ts', '/home/tim/Projects/haruspex').matched).toBe(false);
		expect(
			check('grep -r foo /home/tim/Projects/haruspex/src', '/home/tim/Projects/haruspex').matched
		).toBe(false);
		// A sibling project is not the source tree.
		expect(check('cat /home/tim/Projects/haruspex/src/x.ts').reasons).toEqual([
			"touches Haruspex's source tree"
		]);
	});

	it('does not mistake a longer name for the directory', () => {
		expect(check('ls /home/tim/.local/share/com.haruspex.app2').matched).toBe(false);
	});

	it('reads Windows paths in either slash and any case', () => {
		const win: ProtectedTargets = {
			home: 'C:\\Users\\tim',
			paths: [
				{ path: 'C:\\Users\\tim\\AppData\\Roaming\\com.haruspex.app\\', label: 'data directory' }
			],
			ports: []
		};
		for (const cmd of [
			'type C:\\Users\\tim\\AppData\\Roaming\\com.haruspex.app\\settings.json',
			'type c:/users/tim/appdata/roaming/com.haruspex.app/settings.json',
			'type %USERPROFILE%\\AppData\\Roaming\\com.haruspex.app\\x',
			'Get-Content $env:USERPROFILE\\AppData\\Roaming\\com.haruspex.app\\x'
		]) {
			expect(checkBoundary(cmd, win, 'C:\\code\\game').matched, cmd).toBe(true);
		}
	});
});
