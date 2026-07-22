import { z } from "zod";
import {
  ACTIVITY_FILTERS,
  PROJECT_SORTS,
  PROJECT_VIEWS,
  REPOSITORY_FILTERS,
  type ProjectSearchQuery,
} from "../domain";

const optionalText = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === ""
        ? undefined
        : typeof value === "string"
          ? value.trim()
          : value,
    z.string().min(1).max(maximum).optional(),
  );

const optionalBoolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

const resourceIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);

const pageLimit = z
  .string()
  .regex(/^\d{1,3}$/, "Limit must be an integer between 1 and 100.")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100))
  .optional();

const rawProjectQuerySchema = z
  .object({
    q: optionalText(200),
    channel: resourceIdentifier.optional(),
    repository: z.enum(REPOSITORY_FILTERS).optional(),
    language: optionalText(64),
    license: optionalText(64),
    activity: z.enum(ACTIVITY_FILTERS).optional(),
    collection: resourceIdentifier.optional(),
    impressive: optionalBoolean,
    sort: z.enum(PROJECT_SORTS).optional(),
    view: z.enum(PROJECT_VIEWS).optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "Cursor is not valid.")
      .optional(),
    limit: pageLimit,
  })
  .strict();

export const projectQuerySchema = rawProjectQuerySchema.transform(
  (query): ProjectSearchQuery => ({
    ...query,
    sort: query.sort ?? (query.q ? "relevance" : "recently_seen"),
    view: query.view ?? "cards",
    limit: query.limit ?? 24,
  }),
);

export type ProjectQuery = z.output<typeof projectQuerySchema>;

function queryParamsToObject(params: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    // Duplicate scalar parameters are rejected by the schema rather than silently
    // selecting a value with surprising authorization or cache semantics.
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

export function parseProjectQuery(
  input: URLSearchParams | Record<string, unknown>,
): ProjectSearchQuery {
  return projectQuerySchema.parse(
    input instanceof URLSearchParams ? queryParamsToObject(input) : input,
  );
}
