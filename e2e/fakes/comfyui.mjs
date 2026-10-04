/**
 * A fake ComfyUI for the real-app tests: one GPU, one SD checkpoint, and a
 * queue that finishes every prompt at once with a 2×2 PNG. Just the routes the
 * app's client uses (src/lib/image/comfyui/client.ts); the progress socket is
 * absent, which the client survives by polling /history.
 */
import http from 'node:http';
import { deflateSync } from 'node:zlib';

export const CHECKPOINT = 'e2e-sd15.safetensors';

/** A valid w×h RGB PNG, all one colour. */
export function png(w = 2, h = 2) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.concat(
		Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x55)]))
	);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(rows)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

export function createFakeComfy() {
	const prompts = new Map();
	let next = 1;
	const json = (res, status, body) => {
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(body));
	};
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const p = url.pathname;
			if (p === '/system_stats') return json(res, 200, { devices: [{ name: 'E2E GPU' }] });
			if (p === '/object_info/CheckpointLoaderSimple') {
				return json(res, 200, {
					CheckpointLoaderSimple: { input: { required: { ckpt_name: [[CHECKPOINT]] } } }
				});
			}
			if (p.startsWith('/object_info/')) {
				const cls = p.split('/').pop();
				return json(res, 200, { [cls]: { input: { required: {} } } });
			}
			if (p === '/prompt' && req.method === 'POST') {
				const graph = JSON.parse(body).prompt ?? {};
				const save = Object.entries(graph).find(([, n]) => n?.class_type === 'SaveImage')?.[0];
				const id = `e2e-${next++}`;
				prompts.set(id, save);
				return json(res, 200, { prompt_id: id, number: 0 });
			}
			if (p.startsWith('/history/')) {
				const id = p.slice('/history/'.length);
				const save = prompts.get(id);
				if (!save) return json(res, 200, {});
				return json(res, 200, {
					[id]: {
						outputs: {
							[save]: { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] }
						}
					}
				});
			}
			if (p === '/view') {
				res.writeHead(200, { 'Content-Type': 'image/png' });
				return res.end(png());
			}
			if (p === '/queue') return json(res, 200, { queue_running: [], queue_pending: [] });
			json(res, 404, { error: `fake comfyui: no route ${req.method} ${p}` });
		});
	});
	return {
		prompts,
		listen: (port = 18188) =>
			new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))),
		close: () => new Promise((r) => server.close(() => r()))
	};
}
