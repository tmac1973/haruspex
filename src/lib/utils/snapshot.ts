/**
 * A plain deep copy, safe to take of a Svelte 5 `$state` proxy. `undefined`
 * comes back as `null`.
 *
 * `structuredClone` throws `DataCloneError` on a proxy, and the settings
 * sections all edit a working copy held in `$state` before handing it back
 * to the settings store — so without this, storing one poisons the settings
 * object: every later `structuredClone` of it throws, which in a Svelte
 * template aborts the render and leaves the panel stuck on whatever it was
 * showing. The engine's state and events go out over IPC and the Remote
 * control API the same way.
 *
 * Everything it is used on is JSON — strings, numbers, booleans, null — so a
 * JSON round-trip is both a complete copy and a proxy stripper.
 */
export function snapshot<T>(value: T): T {
	return JSON.parse(JSON.stringify(value ?? null)) as T;
}
