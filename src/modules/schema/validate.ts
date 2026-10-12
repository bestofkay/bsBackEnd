/**
 * Formal JSON Schema validation for public extraction responses.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";

type AjvConstructor = new (options?: object) => {
  compile: (schema: object) => ValidateFunction;
};

const Ajv2020 = (AjvModule as unknown as { default?: AjvConstructor }).default ??
  (AjvModule as unknown as AjvConstructor);

const addFormats =
  (addFormatsModule as unknown as { default?: (ajv: unknown) => unknown }).default ??
  (addFormatsModule as unknown as (ajv: unknown) => unknown);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadSchema(): object {
  const candidates = [
    path.resolve(__dirname, "../../../schemas/extraction-response.schema.json"),
    path.resolve(process.cwd(), "schemas/extraction-response.schema.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as object;
    }
  }
  throw new Error("extraction-response.schema.json not found");
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
addFormats(ajv);

const schema = loadSchema();
const validateFn = ajv.compile(schema);

export type SchemaValidationResult<T = Record<string, unknown>> =
  | { ok: true; value: T }
  | { ok: false; errors: Array<{ path: string; message: string }> };

export function validatePublicExtractionResponse<T = Record<string, unknown>>(
  payload: unknown,
): SchemaValidationResult<T> {
  const ok = validateFn(payload);
  if (ok) {
    return { ok: true, value: payload as T };
  }
  const errors = (validateFn.errors ?? []).map((e: ErrorObject) => ({
    path: e.instancePath || e.schemaPath,
    message: e.message ?? "schema validation failed",
  }));
  return { ok: false, errors };
}

export { schema as extractionResponseSchema };
