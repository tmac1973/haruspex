/**
 * The control channel between `drive start`'s long-lived process and the
 * short-lived `drive send`, `drive state` and the rest.
 *
 * A Unix socket (a named pipe on Windows), not a TCP port, so nothing else on
 * the machine can reach it. One per machine, because the app under test uses
 * the e2e identifier's data directory, and two drivers would wipe each
 * other's. JSON lines: the client sends `{ cmd, args }` and gets one
 * `{ ok: true, value }` or `{ ok: false, error }` back.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the socket and the running driver's details live. */
export function controlPaths(env = process.env, platform = process.platform) {
	const dir = env.XDG_RUNTIME_DIR || tmpdir();
	return {
		socket: platform === 'win32' ? '\\\\.\\pipe\\haruspex-drive' : join(dir, 'haruspex-drive.sock'),
		info: join(dir, 'haruspex-drive.json')
	};
}

/** Split a byte stream into JSON lines. */
export function lineReader(onMessage) {
	let buf = '';
	return (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) onMessage(JSON.parse(line));
		}
	};
}

export const encode = (msg) => JSON.stringify(msg) + '\n';

/**
 * Answer requests on `path` with `handle(cmd, args)`. A handler that throws
 * answers `{ ok: false }`; the connection stays usable either way.
 */
export function serve(path, handle) {
	if (process.platform !== 'win32') rmSync(path, { force: true });
	const server = createServer((sock) => {
		sock.setEncoding('utf8');
		sock.on('error', () => {});
		sock.on(
			'data',
			lineReader(async (msg) => {
				let reply;
				try {
					reply = { ok: true, value: await handle(msg.cmd, msg.args ?? {}) };
				} catch (e) {
					reply = { ok: false, error: String(e?.message ?? e) };
				}
				if (!sock.destroyed) sock.write(encode(reply));
			})
		);
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(path, () => resolve(server));
	});
}

/** Send one request and wait for its answer. */
export function request(path, cmd, args = {}, { timeoutMs = 120_000 } = {}) {
	return new Promise((resolve, reject) => {
		const sock = connect(path);
		sock.setEncoding('utf8');
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error(`${cmd}: no answer from the driver in ${timeoutMs / 1000}s`));
		}, timeoutMs);
		sock.once('error', (e) => {
			clearTimeout(timer);
			if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
				reject(
					Object.assign(new Error('no driver is running: npm run drive -- start'), { code: e.code })
				);
			} else reject(e);
		});
		sock.on(
			'data',
			lineReader((msg) => {
				clearTimeout(timer);
				sock.end();
				if (msg.ok) resolve(msg.value);
				else reject(new Error(msg.error));
			})
		);
		sock.write(encode({ cmd, args }));
	});
}

export function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

/** The running driver, or null. A file whose process is gone is removed. */
export function readInfo(paths = controlPaths()) {
	if (!existsSync(paths.info)) return null;
	let info;
	try {
		info = JSON.parse(readFileSync(paths.info, 'utf8'));
	} catch {
		info = null;
	}
	if (info && isAlive(info.pid)) return info;
	clearInfo(paths);
	return null;
}

export function writeInfo(info, paths = controlPaths()) {
	writeFileSync(paths.info, JSON.stringify(info, null, '\t') + '\n');
}

export function clearInfo(paths = controlPaths()) {
	rmSync(paths.info, { force: true });
	if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
}
