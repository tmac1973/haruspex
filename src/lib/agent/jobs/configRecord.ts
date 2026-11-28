/**
 * A job's `type_config` JSON as a plain object to read fields from. Missing,
 * malformed, or not an object (an array, a number): `{}`, so a bad config
 * behaves like no config and every field takes its default.
 */
export function configRecord(json: string | null): Record<string, unknown> {
	if (!json) return {};
	try {
		const parsed: unknown = JSON.parse(json);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
