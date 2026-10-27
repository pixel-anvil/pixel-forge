/**
 * The one record schema of the model. zod's `z.record` never validates or keeps a `__proto__` key
 * (it skips it, because assigning it would replace the result's prototype), so a plain record would
 * silently drop `{"__proto__": ...}` and break "parsing is identity". Every keyed map of the schema
 * goes through {@link record}, which rejects reserved property names up front.
 * @packageDocumentation
 */
import { z } from 'zod';
import { RESERVED_PROPERTY_NAMES } from './constants.js';

const reserved: ReadonlySet<string> = new Set(RESERVED_PROPERTY_NAMES);

/**
 * `z.record(key, value)` that fails (rather than drops) an own key colliding with a member of
 * `Object.prototype` (see `RESERVED_PROPERTY_NAMES`). The issue path ends at the offending key.
 * The key schema still validates every other key.
 */
export const record = <K extends z.core.$ZodRecordKey, V extends z.core.$ZodType>(
  keyType: K,
  valueType: V,
) => {
  const structure = z.record(keyType, valueType);
  return z
    .custom<z.input<typeof structure>>()
    .superRefine((value: unknown, ctx) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      for (const key of Object.keys(value)) {
        if (reserved.has(key)) {
          ctx.addIssue({
            code: 'custom',
            message: `"${key}" is a reserved JavaScript property name and cannot be a key`,
            path: [key],
          });
        }
      }
    })
    .pipe(structure);
};
