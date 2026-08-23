import {
  Type,
  type Meta,
  type TEnum,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";

/**
 * Build a string enum that is valid both to TypeBox and to strict tool-schema
 * consumers. Type.Enum preserves the TypeScript literal union but emits only
 * `enum` by default; JSON Schema providers expect the primitive `type` too.
 */
export function stringEnum<const Values extends string[]>(
  values: readonly [...Values],
  options: Meta = {},
): TEnum<Values> {
  return Type.Enum(values, { ...options, type: "string" });
}
