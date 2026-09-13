/**
 * Minimal zod-like placeholder — actual validation is in tool files via createSchema.
 * This file exists to satisfy import path.
 */
export const z = {
  string: () => ({ type: 'string' }),
  number: () => ({ type: 'number' }),
  boolean: () => ({ type: 'boolean' }),
};
