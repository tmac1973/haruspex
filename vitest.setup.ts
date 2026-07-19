/**
 * Restore a working `localStorage` under jsdom on Node >= 24.
 *
 * Node ships its own experimental Web Storage global. It is inert unless the
 * process was started with `--localstorage-file`, but it is still installed on
 * `globalThis` as a getter that returns `undefined` — and it shadows the
 * Storage that jsdom would otherwise provide. Because Vitest's jsdom
 * environment exposes the same object as both `window` and `globalThis`, both
 * `localStorage` and `window.localStorage` come back undefined, and any test
 * that touches storage dies with "Cannot read properties of undefined".
 *
 * CI runs Node 22, which has no such built-in, so jsdom's Storage lands
 * normally and this shim never fires. It exists so the suite behaves the same
 * on a newer local toolchain instead of failing five tests that pass in CI.
 *
 * The in-memory implementation is deliberate rather than a re-export of
 * jsdom's: by the time setup runs, jsdom's own Storage is already shadowed and
 * not reachable. It implements the Storage interface faithfully enough for the
 * store code under test — string coercion, `null` for missing keys, `length`
 * and `key()` in insertion order.
 */
class MemoryStorage implements Storage {
	#entries = new Map<string, string>();

	get length(): number {
		return this.#entries.size;
	}

	key(index: number): string | null {
		return [...this.#entries.keys()][index] ?? null;
	}

	getItem(key: string): string | null {
		// Storage returns null (not undefined) for an absent key.
		return this.#entries.has(String(key)) ? (this.#entries.get(String(key)) as string) : null;
	}

	setItem(key: string, value: string): void {
		this.#entries.set(String(key), String(value));
	}

	removeItem(key: string): void {
		this.#entries.delete(String(key));
	}

	clear(): void {
		this.#entries.clear();
	}
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
	// Only step in when the global is genuinely unusable. On Node 22 (CI) jsdom
	// has already provided a real Storage and this leaves it untouched.
	const existing = (globalThis as Record<string, unknown>)[name];
	if (existing != null) return;

	Object.defineProperty(globalThis, name, {
		value: new MemoryStorage(),
		configurable: true,
		writable: true
	});
}

installStorage('localStorage');
installStorage('sessionStorage');
