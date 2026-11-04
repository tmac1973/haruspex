// The Khronos glTF validator ships no types; `validate.ts` uses only this.
declare module 'gltf-validator' {
	export function validateBytes(
		data: Uint8Array,
		options?: Record<string, unknown>
	): Promise<{
		issues: {
			numErrors: number;
			messages: { code: string; message: string; severity: number; pointer?: string }[];
		};
	}>;
}
