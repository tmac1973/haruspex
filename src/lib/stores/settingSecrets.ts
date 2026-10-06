/**
 * A single credential held in the settings as a pair of fields: the value
 * itself, inline only where no secret store works, and a flag saying one is
 * kept in the store under `secretKey`. Rust reads the stored value when it
 * needs it; the webview sends only the inline one.
 */
import { getSettings, updateSettings, type AppSettings } from './settings';
import { deleteSecret, keepSecret, secretStoreAvailable, setSecret } from './secrets';

type StringKey = {
	[K in keyof AppSettings]: AppSettings[K] extends string ? K : never;
}[keyof AppSettings];
type BoolKey = {
	[K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];

export interface SettingSecret {
	save(value: string): Promise<void>;
	remove(): Promise<void>;
	/** Move an inline value out of the settings. Runs at every start; a no-op
	 *  once done or where no store works. */
	migrate(): Promise<void>;
	configured(s?: AppSettings): boolean;
}

export function settingSecret(
	secretKey: string,
	inlineField: StringKey,
	savedField: BoolKey
): SettingSecret {
	const write = (inline: string, saved: boolean) =>
		updateSettings({ [inlineField]: inline, [savedField]: saved } as Partial<AppSettings>);
	return {
		async save(value) {
			const { inline, ref } = await keepSecret(secretKey, value);
			write(inline, ref !== undefined);
		},
		async remove() {
			await deleteSecret(secretKey);
			write('', false);
		},
		async migrate() {
			const inline = getSettings()[inlineField] as string;
			if (!inline || !(await secretStoreAvailable())) return;
			try {
				await setSecret(secretKey, inline);
			} catch (e) {
				console.warn(`Could not move ${secretKey} out of the settings:`, e);
				return;
			}
			if (getSettings()[inlineField] === inline) write('', true);
		},
		configured(s = getSettings()) {
			return (s[inlineField] as string) !== '' || (s[savedField] as boolean);
		}
	};
}
