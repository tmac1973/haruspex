/**
 * The generation servers saved in Settings → Image generation, Music and Video
 * (`settings.generationServers`), read and changed for the address
 * dropdowns. A llama-toolchest is one entry for all three, so saving it in
 * Image lists it in Music too.
 */
import {
	getSettings,
	normalizeServerUrl,
	updateSettings,
	type GenerationServer,
	type GenerationServerKind
} from '#lib/stores/settings.ts';

/**
 * The address and key an editor takes when the user picks `saved` from the
 * address dropdown. A saved server brings its own key, none included: the
 * key of the server picked before belongs to that server and must not be
 * sent to this one. Choosing no saved server clears the address and keeps
 * the key, for the user to type an address it goes with.
 */
export function pickedServer(
	saved: GenerationServer | null,
	keyId: string | null
): { url: string; keyId: string | null } {
	return saved ? { url: saved.url, keyId: saved.keyId } : { url: '', keyId };
}

/** Bumped on every change, so a dropdown reading the list redraws. */
let revision = $state(0);

/** The saved servers that run `kind`, in the order they were saved. */
export function savedServers(kind: GenerationServerKind): GenerationServer[] {
	void revision;
	return getSettings().generationServers.filter((s) => s.kind === kind);
}

/**
 * Save a server, or update the key of one already saved. An empty address
 * saves nothing.
 */
export function rememberServer(
	kind: GenerationServerKind,
	url: string,
	keyId: string | null = null
): void {
	const at = normalizeServerUrl(url);
	if (!at) return;
	const all = getSettings().generationServers;
	const i = all.findIndex((s) => s.kind === kind && s.url === at);
	if (i >= 0 && all[i].keyId === keyId) return;
	const entry: GenerationServer = { kind, url: at, keyId };
	const next = i >= 0 ? all.map((s, j) => (j === i ? entry : s)) : [...all, entry];
	updateSettings({ generationServers: next });
	revision++;
}

export function forgetServer(kind: GenerationServerKind, url: string): void {
	const at = normalizeServerUrl(url);
	const all = getSettings().generationServers;
	const next = all.filter((s) => !(s.kind === kind && s.url === at));
	if (next.length === all.length) return;
	updateSettings({ generationServers: next });
	revision++;
}
