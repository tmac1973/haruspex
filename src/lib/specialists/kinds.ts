/**
 * The specialist kinds, registered by their modules in `kinds/`. The tool's
 * schema and the settings editor are built from what is registered here, so
 * a new kind is one module and one import in `kinds/index.ts`.
 */
import type { SpecialistKind, SpecialistParam } from '#lib/specialists/types.ts';

/** The tool's own fields, which no kind may declare. */
const RESERVED = new Set(['name', 'request', 'images']);

const kinds = new Map<string, SpecialistKind>();

/** `value` without any `description`, keys sorted, as one string. */
function shape(value: unknown): string {
	const strip = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(strip);
		if (v && typeof v === 'object') {
			return Object.fromEntries(
				Object.keys(v)
					.filter((k) => k !== 'description')
					.sort()
					.map((k) => [k, strip((v as Record<string, unknown>)[k])])
			);
		}
		return v;
	};
	return JSON.stringify(strip(value));
}

/**
 * Two kinds may share a param name only when it means the same thing: the
 * tool merges every kind's params into one schema.
 */
function sameParam(a: SpecialistParam, b: SpecialistParam): boolean {
	return a.required === b.required && shape(a.schema) === shape(b.schema);
}

export function registerSpecialistKind(kind: SpecialistKind): void {
	if (kinds.has(kind.id)) throw new Error(`Specialist kind '${kind.id}' is already registered.`);
	for (const [name, param] of Object.entries(kind.params)) {
		if (RESERVED.has(name)) {
			throw new Error(`Specialist kind '${kind.id}' declares '${name}', the tool's own field.`);
		}
		for (const other of kinds.values()) {
			const theirs = other.params[name];
			if (theirs && !sameParam(theirs, param)) {
				throw new Error(
					`Specialist kinds '${other.id}' and '${kind.id}' declare '${name}' differently.`
				);
			}
		}
	}
	kinds.set(kind.id, kind);
}

export function specialistKind(id: string): SpecialistKind | undefined {
	return kinds.get(id);
}

/** In registration order. */
export function specialistKinds(): SpecialistKind[] {
	return [...kinds.values()];
}

/** Tests only: forget a kind registered by the test. */
export function unregisterSpecialistKind(id: string): void {
	kinds.delete(id);
}
