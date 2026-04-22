import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildIr } from "jsr:@disjukr/bdl@0.8.3/io/ir";
import type {
  BdlIr,
  Custom,
  Def,
  Enum,
  Struct,
  StructField,
  Type as IrType,
  Union,
} from "jsr:@disjukr/bdl@0.8.3/ir";

type JsonSchema = Record<string, unknown>;

const configPath = "bdl.yaml";
const rootTypeName = "Nurijips";
const outputPath = "schema/generated/nurijip.schema.json";

const localName = (typePath: string) => typePath.split(".").at(-1)!;
const description = (attributes: Record<string, string>) =>
  attributes.description ? { description: attributes.description } : {};

function ref(typePath: string): JsonSchema {
  const typeName = localName(typePath);
  return typeName === "string" ? { type: "string" } : { $ref: `#/$defs/${typeName}` };
}

function renderType(type: IrType): JsonSchema {
  if (type.type === "Dictionary") {
    return { type: "object", additionalProperties: ref(type.valueTypePath) };
  }
  if (type.type === "Array") {
    return { type: "array", items: ref(type.valueTypePath) };
  }
  return ref(type.valueTypePath);
}

function renderStruct(def: Struct): JsonSchema {
  const properties = Object.fromEntries(
    def.fields.map((field) => [field.name, { ...renderType(field.fieldType), ...description(field.attributes) }]),
  );
  const required = def.fields.filter((field) => !field.optional).map((field) => field.name);
  return { type: "object", properties, required, additionalProperties: false, ...description(def.attributes) };
}

function renderEnum(def: Enum): JsonSchema {
  return { type: "string", enum: def.items.map((item) => item.attributes.value ?? item.name), ...description(def.attributes) };
}

function renderUnion(def: Union): JsonSchema {
  const discriminator = def.attributes.discriminator ?? "kind";
  return {
    oneOf: def.items.map((item) => {
      const fields: StructField[] = [
        { attributes: {}, name: discriminator, fieldType: { type: "Plain", valueTypePath: "string" }, optional: false },
        ...item.fields,
      ];
      const properties = Object.fromEntries(fields.map((field) => [field.name, renderType(field.fieldType)]));
      properties[discriminator] = { const: item.name };
      return {
        type: "object",
        properties,
        required: fields.filter((field) => !field.optional).map((field) => field.name),
        additionalProperties: false,
        ...description(item.attributes),
      };
    }),
    ...description(def.attributes),
  };
}

function renderDefinition(definition: Def): JsonSchema {
  if (definition.type === "Custom") {
    const def = definition as Custom;
    return { ...renderType(def.originalType), ...description(def.attributes) };
  }
  if (definition.type === "Enum") {
    return renderEnum(definition as Enum);
  }
  if (definition.type === "Struct") {
    return renderStruct(definition as Struct);
  }
  return renderUnion(definition as Union);
}

function getOrderedDefinitions(ir: BdlIr): Def[] {
  const seen = new Set();
  return Object.values(ir.modules)
    .flatMap((module) => module.defPaths)
    .filter((defPath) => {
      if (seen.has(defPath)) {
        return false;
      }
      seen.add(defPath);
      return true;
    })
    .map((defPath) => ir.defs[defPath]!);
}

function renderJsonSchema(ir: BdlIr): JsonSchema {
  const defs = Object.fromEntries(getOrderedDefinitions(ir).map((def) => [def.name, renderDefinition(def)]));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/disjukr/awesome-nurijip/schema/generated/nurijip.schema.json",
    title: rootTypeName,
    ...defs[rootTypeName],
    properties: { $schema: { type: "string" } },
    $defs: defs,
  };
}

async function main() {
  const { ir } = await buildIr({
    config: configPath,
    standard: "conventional",
    omitFileUrl: true,
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(renderJsonSchema(ir), null, 2)}\n`, "utf8");
  console.log(`wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  Deno.exit(1);
});
