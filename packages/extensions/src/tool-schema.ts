import { Type, type TEnum, type TSchema } from "typebox";

/**
 * Build a string enum that is valid both to TypeBox and to strict tool-schema
 * consumers. `Type.Enum` emits only `enum` by default; JSON Schema providers
 * expect the primitive `type` too.
 */
export function stringEnum<const Values extends string[]>(
  values: readonly [...Values],
  options: Record<string, unknown> = {},
): TEnum<Values> {
  return Type.Enum(values, { ...options, type: "string" });
}

export type { TSchema };
