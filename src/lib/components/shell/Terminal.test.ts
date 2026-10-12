import { describe, expect, it, vi } from 'vitest';

// xterm and the serialize addon probe for a 2D canvas at import time; jsdom
// has none and logs a "Not implemented" stack for each. Answer "no canvas"
// (what they already fall back to) before the imports below run.
vi.hoisted(() => {
	HTMLCanvasElement.prototype.getContext = () => null;
});

import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';

// Terminal.svelte hands scrollback between windows as a SerializeAddon
// snapshot that the new window writes into a fresh terminal
// (`shell_take_scrollback` → `t.write(snapshot)`). Pin that round trip so an
// xterm upgrade that changes the format shows up here, not in a detached tab.

function makeTerminal() {
	const term = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true });
	const serialize = new SerializeAddon();
	term.loadAddon(serialize);
	return { term, serialize };
}

const write = (term: Terminal, data: string) =>
	new Promise<void>((resolve) => term.write(data, resolve));

describe('scrollback handoff', () => {
	it('repaints text, colours and history from a serialized snapshot', async () => {
		const source = makeTerminal();
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
		await write(source.term, lines.join('\r\n') + '\r\n');
		await write(source.term, '\x1b[31mred\x1b[0m \x1b[1;38;2;10;20;30mrgb bold\x1b[0m');
		const snapshot = source.serialize.serialize();

		const target = makeTerminal();
		await write(target.term, snapshot);

		expect(target.serialize.serialize()).toBe(snapshot);
		const buf = target.term.buffer.active;
		// History beyond the 5 visible rows came across as scrollback.
		expect(buf.getLine(0)?.translateToString(true)).toBe('line 0');
		const last = buf.getLine(buf.length - 1);
		expect(last?.translateToString(true)).toBe('red rgb bold');
		const red = last?.getCell(0);
		expect(red?.isFgPalette()).toBe(true);
		expect(red?.getFgColor()).toBe(1);
		const rgb = last?.getCell(4);
		expect(rgb?.isFgRGB()).toBe(true);
		expect(rgb?.getFgColor()).toBe((10 << 16) | (20 << 8) | 30);
		expect(rgb?.isBold()).toBeTruthy();

		source.term.dispose();
		target.term.dispose();
	});
});
