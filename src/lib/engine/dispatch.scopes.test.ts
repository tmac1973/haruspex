import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

/** Every `case 'x.y':` in a switch: the operations a file answers. */
const cases = (src: string) =>
	[...src.matchAll(/case '([a-zA-Z]+\.[a-zA-Z.]+)':/g)].map((m) => m[1]);

describe('operation scopes', () => {
	// The owner API refuses an operation `required_scope` doesn't know, so an
	// operation added here without its scope in Rust can never be reached.
	it('gives every operation the engine answers a scope in Rust', () => {
		const rust = read('../../../src-tauri/src/owner/clients.rs');
		const fn = rust.slice(rust.indexOf('pub fn required_scope'), rust.indexOf('_ => return None'));
		const scoped = new Set([...fn.matchAll(/"([a-zA-Z]+\.[a-zA-Z.]+)"/g)].map((m) => m[1]));
		const answered = [...cases(read('dispatch.ts')), ...cases(read('chat.svelte.ts'))];
		expect(answered.length).toBeGreaterThan(20);
		expect(answered.filter((op) => !scoped.has(op))).toEqual([]);
	});
});
