import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

type Nurijip = {
  scope: string;
  role: string;
  title: string;
  description: string;
};

const dataDir = "data";
const schemaPath = "schema/generated/nurijip.schema.json";
const expectedItemKeys = ["scope", "role", "title", "description"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function assert(condition: unknown, message: string, errors: string[]) {
  if (!condition) errors.push(message);
}

async function getDataPaths() {
  if (Deno.args.length) return Deno.args;
  const names = await readdir(dataDir);
  return names.filter((name) => /^nurijips-.+\.json$/.test(name)).sort((a, b) => a.localeCompare(b)).map((name) => path.join(dataDir, name));
}

async function getEnums() {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return {
    roles: new Set<string>(schema.$defs.NurijipRole.enum),
    scopes: new Set<string>(schema.$defs.NurijipScope.enum),
  };
}

function validateItem(file: string, key: string, value: unknown, scopes: Set<string>, roles: Set<string>, errors: string[]) {
  assert(isRecord(value), `${file}: ${key} must be an object`, errors);
  if (!isRecord(value)) return;
  const item = value as Partial<Nurijip>;
  const itemKeys = Object.keys(value);
  assert(itemKeys.join(",") === expectedItemKeys.join(","), `${file}: ${key} must have keys ${expectedItemKeys.join(",")} in order`, errors);
  assert(scopes.has(item.scope ?? ""), `${file}: ${key}.scope has invalid value ${JSON.stringify(item.scope)}`, errors);
  assert(roles.has(item.role ?? ""), `${file}: ${key}.role has invalid value ${JSON.stringify(item.role)}`, errors);
  assert(typeof item.title === "string", `${file}: ${key}.title must be a string`, errors);
  assert(typeof item.description === "string", `${file}: ${key}.description must be a string`, errors);
}

async function validateFile(file: string, scopes: Set<string>, roles: Set<string>) {
  const errors: string[] = [];
  const source = await readFile(file, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return [`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  assert(isRecord(data), `${file}: root must be an object`, errors);
  if (!isRecord(data)) return errors;
  assert(source === `${JSON.stringify(data, null, 2)}\n`, `${file}: JSON formatting must match JSON.stringify(data, null, 2) with trailing newline`, errors);
  const keys = Object.keys(data);
  assert(keys[0] === "$schema", `${file}: $schema must be the first key`, errors);
  assert(typeof data.$schema === "string", `${file}: $schema must be a string`, errors);
  const itemKeys = keys.filter((key) => key !== "$schema");
  const sortedItemKeys = [...itemKeys].sort((a, b) => a.localeCompare(b));
  assert(itemKeys.every((key, index) => key === sortedItemKeys[index]), `${file}: item keys must be sorted lexicographically`, errors);
  for (const key of itemKeys) validateItem(file, key, data[key], scopes, roles, errors);
  return errors;
}

async function main() {
  const { roles, scopes } = await getEnums();
  const dataPaths = await getDataPaths();
  const results = await Promise.all(dataPaths.map(async (file) => ({ errors: await validateFile(file, scopes, roles), file })));
  const errors = results.flatMap(({ errors }) => errors);
  for (const { errors, file } of results) console.log(`${errors.length ? "fail" : "ok"} ${file}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    Deno.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  Deno.exit(1);
});
