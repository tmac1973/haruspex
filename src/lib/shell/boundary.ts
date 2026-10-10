/**
 * Does a shell command reach outside its project, into Haruspex itself?
 *
 * On 2026-10-02 an unattended coding run, blocked by art its chain had failed
 * to make, read Haruspex's own database and source to find out why, then made
 * the art itself through the user's ComfyUI. Its diagnosis was right; nothing
 * had stopped it. File tools are confined to the working directory already;
 * this covers `run_command`, whose shell can touch anything the user can.
 *
 * A fence against accidents, not a sandbox: a command that builds a path at
 * run time gets past it. The prompt tells the run where its boundary is; this
 * catches the run that forgets.
 */
import { invoke } from '@tauri-apps/api/core';
import type { ProtectedTargets } from '#lib/ipc/gen/ProtectedTargets.ts';
import type { ProtectedPort } from '#lib/ipc/gen/ProtectedPort.ts';
import { getSettings } from '#lib/stores/settings.ts';

export interface BoundaryCheck {
	matched: boolean;
	/** "touches Haruspex's data directory", "calls Haruspex's image engine (port 8767)". */
	reasons: string[];
}

/** Forward slashes, so either spelling compares. */
function slashes(path: string): string {
	return path.replace(/\\/g, '/');
}

/**
 * A Windows path (`C:/…`), or one through WSL's mount of a Windows drive
 * (`/mnt/c/…`): compared without regard to case, as Windows does.
 */
function isWindowsPath(path: string): boolean {
	return /^[a-z]:\//i.test(path) || /^\/mnt\/[a-z]\//i.test(path);
}

/** `C:\Users\tim\x\` as a WSL distro sees it: `/mnt/c/Users/tim/x/`. Null for any other path. */
export function wslMountPath(path: string): string | null {
	const m = /^([a-z]):[\\/](.*)$/i.exec(path);
	return m ? `/mnt/${m[1].toLowerCase()}/${slashes(m[2])}` : null;
}

/**
 * What to guard for a command that runs inside a WSL distro: each Windows
 * directory also under its `/mnt/<drive>/…` spelling, and no home to expand,
 * since `~` there is the distro's Linux home, not the Windows one.
 */
export function wslTargets(targets: ProtectedTargets): ProtectedTargets {
	const paths = targets.paths.flatMap((p) => {
		const mount = wslMountPath(p.path);
		return mount ? [p, { ...p, path: mount }] : [p];
	});
	return { ...targets, home: '', paths };
}

/**
 * The command with the home-directory spellings a shell would expand,
 * expanded; Windows' `APPDATA` and `LOCALAPPDATA` too, at their usual places
 * under the home, where Haruspex keeps its data.
 */
function expandHome(command: string, home: string): string {
	if (!home) return command;
	const h = home.replace(/[\\/]+$/, '');
	return command
		.replace(/(^|[\s'"=:(])~(?=[\\/])/g, (_m, pre: string) => pre + h)
		.replace(/\$\{HOME\}|\$HOME\b/g, h)
		.replace(/%USERPROFILE%|\$\{?env:USERPROFILE\b\}?/gi, h)
		.replace(/%APPDATA%|\$\{?env:APPDATA\b\}?/gi, `${h}\\AppData\\Roaming`)
		.replace(/%LOCALAPPDATA%|\$\{?env:LOCALAPPDATA\b\}?/gi, `${h}\\AppData\\Local`);
}

const LOOPBACK_PORT =
	/(?:\blocalhost|\b127\.0\.0\.1|\b0\.0\.0\.0|\[::1\])(?::(\d{2,5})|\s+(\d{2,5})\b)/gi;

export function checkBoundary(
	command: string,
	targets: ProtectedTargets,
	root: string | null
): BoundaryCheck {
	const reasons: string[] = [];
	const cmd = slashes(expandHome(command, targets.home));
	const cmdLower = cmd.toLowerCase();

	for (const { path, label } of targets.paths) {
		let p = slashes(path).replace(/\/+$/, '') + '/';
		const windows = isWindowsPath(p);
		if (windows) p = p.toLowerCase();
		const haystack = windows ? cmdLower : cmd;
		const rootN = root ? slashes(root).replace(/\/+$/, '') + '/' : null;
		const r = rootN && windows ? rootN.toLowerCase() : rootN;
		// The user may run a coding job on Haruspex's own repo: a protected
		// directory that contains the run's root, or sits inside it, is the
		// project itself.
		if (r && (r.startsWith(p) || p.startsWith(r))) continue;
		const bare = p.slice(0, -1);
		if (haystack.includes(p) || new RegExp(`${escape(bare)}(?=[\\s'"]|$)`).test(haystack)) {
			reasons.push(`touches Haruspex's ${label}`);
		}
	}

	const protectedPorts = new Map(targets.ports.map((p) => [p.port, p.label]));
	for (const m of command.matchAll(LOOPBACK_PORT)) {
		const port = Number(m[1] ?? m[2]);
		const label = protectedPorts.get(port);
		if (label) reasons.push(`calls Haruspex's ${label} (port ${port})`);
	}

	const unique = [...new Set(reasons)];
	return { matched: unique.length > 0, reasons: unique };
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The image backend's port when it runs on this machine: it's Haruspex's to guard. */
function imageBackendPort(): ProtectedPort[] {
	const url = getSettings().imageBackendBaseUrl?.trim();
	if (!url) return [];
	try {
		const u = new URL(url);
		if (!['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname)) return [];
		const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
		return [{ port, label: 'image backend' }];
	} catch {
		return [];
	}
}

let memo: { key: string; targets: Promise<ProtectedTargets | null> } | null = null;

/**
 * What to guard, fetched once and kept: the directories never change while the
 * app runs. Keyed by the image backend's port, so changing it in Settings is
 * picked up. Null when the command is unavailable (a test, a browser): the
 * check then guards nothing rather than failing every command.
 */
export async function protectedTargets(
	opts: { wsl?: boolean } = {}
): Promise<ProtectedTargets | null> {
	const extra = imageBackendPort();
	const key = JSON.stringify(extra);
	if (memo?.key !== key) {
		memo = {
			key,
			targets: invoke<ProtectedTargets>('app_protected_targets', { extraPorts: extra }).catch(
				() => null
			)
		};
	}
	// A command inside a WSL distro names Windows folders as /mnt/<drive>/….
	const targets = await memo.targets;
	return targets && opts.wsl ? wslTargets(targets) : targets;
}

/** Test seam. */
export function _resetBoundary(): void {
	memo = null;
	listeners.clear();
}

export interface BoundaryRefusal {
	command: string;
	reasons: string[];
}

const listeners = new Set<(r: BoundaryRefusal) => void>();

/**
 * Hear about every command refused at the boundary until the returned function
 * is called. A coding run listens for the length of the run so its report can
 * list them; runs are serialized, so one listener sees one run's refusals.
 */
export function onBoundaryRefusal(listener: (r: BoundaryRefusal) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function reportBoundaryRefusal(r: BoundaryRefusal): void {
	for (const l of listeners) l(r);
}
