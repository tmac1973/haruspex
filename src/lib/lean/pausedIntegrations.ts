/**
 * What lean mode pauses that the user set up: each integration whose tools
 * a full Chat turn would offer, by the name Settings lists it under. Lean
 * mode leaves their settings and processes alone; the model just isn't
 * offered their tools (see `leanProfile.ts`).
 */
import {
	getSettings,
	hasEnabledCalendarAccount,
	hasEnabledContactsAccount,
	hasEnabledEmailAccount,
	startableMcpServers
} from '#lib/stores/settings.ts';

export function pausedIntegrations(): string[] {
	const s = getSettings();
	return [
		...(hasEnabledEmailAccount() ? ['Email'] : []),
		...(hasEnabledCalendarAccount() ? ['Calendar'] : []),
		...(hasEnabledContactsAccount() ? ['Contacts'] : []),
		...(s.screenCaptureEnabled ? ['Screen capture'] : []),
		...(s.imageBackendKind !== 'none' ? ['Image generation'] : []),
		...(s.musicBackendKind !== 'none' ? ['Music generation'] : []),
		...(s.videoGenBackendKind !== 'none' ? ['Video generation'] : []),
		...(s.sandboxEnabled ? ['Python sandbox'] : []),
		...startableMcpServers().map((m) => `MCP: ${m.label}`)
	];
}
