import { describe, expect, it } from 'vitest';
import { decodeSyncBody } from './syncBody';

/** The body as `encode_sync` lays it out. */
function encode(header: unknown, files: Uint8Array[]): ArrayBuffer {
	const json = new TextEncoder().encode(JSON.stringify(header));
	const total = 4 + json.length + files.reduce((n, f) => n + f.length, 0);
	const out = new Uint8Array(total);
	new DataView(out.buffer).setUint32(0, json.length, true);
	out.set(json, 4);
	let at = 4 + json.length;
	for (const f of files) {
		out.set(f, at);
		at += f.length;
	}
	return out.buffer;
}

describe('decodeSyncBody', () => {
	it('gives each file its own bytes, as views of the one body', () => {
		const body = encode(
			{
				to_sync: [
					{ path: 'a.txt', abs_path: '/w/a.txt', mtime: 1.5, len: 3 },
					{ path: 'é.bin', abs_path: '/w/é.bin', mtime: 2, len: 2 }
				],
				deleted: ['gone.txt'],
				skipped: [{ path: 'big.bin', reason: 'too big' }],
				workdir_abs: '/w'
			},
			[new TextEncoder().encode('one'), new Uint8Array([0, 255])]
		);
		const r = decodeSyncBody(body);
		expect(r.to_sync.map((f) => [f.path, f.abs_path, f.mtime, Array.from(f.bytes)])).toEqual([
			['a.txt', '/w/a.txt', 1.5, [111, 110, 101]],
			['é.bin', '/w/é.bin', 2, [0, 255]]
		]);
		expect(r.to_sync.every((f) => f.bytes.buffer === body)).toBe(true);
		expect(r.deleted).toEqual(['gone.txt']);
		expect(r.skipped).toEqual([{ path: 'big.bin', reason: 'too big' }]);
		expect(r.workdir_abs).toBe('/w');
	});

	it('reads a sync with nothing to send', () => {
		const r = decodeSyncBody(
			encode({ to_sync: [], deleted: [], skipped: [], workdir_abs: '/w' }, [])
		);
		expect(r).toEqual({ to_sync: [], deleted: [], skipped: [], workdir_abs: '/w' });
	});
});
