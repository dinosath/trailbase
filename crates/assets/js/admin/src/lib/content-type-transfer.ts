import { fetchRows } from "@/lib/api/row";
import { adminFetch } from "@/lib/fetch";
import { escapeQualifiedName } from "@/lib/schema";
import type { ContentTypeSchema } from "@/lib/api/content-types";
import type { SqlValue } from "trailbase-bindings";
import { parse as parseYaml } from "yaml";

const TRANSFER_PAGE_SIZE = 500;

function unwrap(value: SqlValue, type?: string): unknown {
  if (value === "Null") return null;
  if ("Integer" in value) {
    if (type === "boolean") return value.Integer !== 0n;
    const number = Number(value.Integer);
    return Number.isSafeInteger(number) ? number : value.Integer.toString();
  }
  if ("Real" in value) return value.Real;
  if ("Blob" in value) return value.Blob;
  if (type === "json" || type === "media") {
    try {
      return JSON.parse(value.Text) as unknown;
    } catch {
      return value.Text;
    }
  }
  return value.Text;
}

export async function exportContentTypeRecords(
  schema: ContentTypeSchema,
): Promise<Record<string, unknown>[]> {
  if (!schema.tableName) throw new Error("Content type has no backing table");
  const table = {
    name: schema.tableName,
    database_schema: schema.databaseSchema ?? "main",
  };
  const output: Record<string, unknown>[] = [];

  for (let page = 0; ; page += 1) {
    const response = await fetchRows(
      table,
      null,
      TRANSFER_PAGE_SIZE,
      page,
      null,
    );
    for (const row of response.rows) {
      const record: Record<string, unknown> = {};
      response.columns.forEach((column, index) => {
        record[column.name] = unwrap(
          row[index],
          schema.attributes[column.name]?.type,
        );
      });
      output.push(record);
    }
    if (response.rows.length < TRANSFER_PAGE_SIZE) return output;
  }
}

function toSqlValue(value: unknown, type?: string): SqlValue {
  if (value === null || value === undefined) return "Null";
  if (
    value === "" &&
    [
      "integer",
      "biginteger",
      "relation",
      "decimal",
      "float",
      "boolean",
      "json",
      "media",
    ].includes(type ?? "")
  ) {
    return "Null";
  }
  if (typeof value === "boolean") return { Integer: value ? 1n : 0n };
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Import contains a non-finite number");
    return Number.isInteger(value)
      ? { Integer: BigInt(value) }
      : { Real: value };
  }
  if (typeof value === "string") {
    if (type === "boolean") {
      if (["true", "1"].includes(value.toLowerCase())) return { Integer: 1n };
      if (["false", "0"].includes(value.toLowerCase())) return { Integer: 0n };
      throw new Error(`Expected true or false, got ${value}`);
    }
    if (["integer", "biginteger", "relation"].includes(type ?? "")) {
      if (!/^-?\d+$/.test(value))
        throw new Error(`Expected an integer, got ${value}`);
      return { Integer: BigInt(value) };
    }
    if (["decimal", "float"].includes(type ?? "")) {
      const number = Number(value);
      if (!Number.isFinite(number))
        throw new Error(`Expected a number, got ${value}`);
      return Number.isInteger(number)
        ? { Integer: BigInt(number) }
        : { Real: number };
    }
    if (["json", "media"].includes(type ?? "")) {
      try {
        return { Text: JSON.stringify(JSON.parse(value) as unknown) };
      } catch {
        return { Text: value };
      }
    }
    return { Text: value };
  }
  if (typeof value === "object") {
    if ("Blob" in value) return value as SqlValue;
    return { Text: JSON.stringify(value) };
  }
  throw new Error(`Unsupported imported value: ${String(value)}`);
}

export async function importContentTypeRecords(
  schema: ContentTypeSchema,
  records: Record<string, unknown>[],
  onProgress: (complete: number) => void,
): Promise<void> {
  if (!schema.tableName) throw new Error("Content type has no backing table");
  for (const [index, record] of records.entries()) {
    const row: Record<string, SqlValue | undefined> = {};
    for (const [name, value] of Object.entries(record)) {
      if (schema.attributes[name]?.computed) continue;
      row[name] = toSqlValue(value, schema.attributes[name]?.type);
    }
    const tableName = escapeQualifiedName({
      name: schema.tableName,
      database_schema: schema.databaseSchema ?? "main",
    });
    const response = await adminFetch(`/table/${tableName}`, {
      method: "POST",
      body: JSON.stringify({ row }),
    });
    if (!response.ok) throw new Error(await response.text());
    onProgress(index + 1);
  }
}

export function parseCsv(source: string): Record<string, unknown>[] {
  return parseDelimited(source, ",");
}

export function parseImportDocument(source: string, filename: string): unknown {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "csv" || extension === "tsv") {
    return parseDelimited(source, extension === "tsv" ? "\t" : ",");
  }
  if (extension === "yaml" || extension === "yml") {
    return parseYaml(source);
  }
  if (extension === "ndjson" || extension === "jsonl") {
    return source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  if (extension === "xml") return parseXml(source);
  if (extension === "json" || !extension) return JSON.parse(source) as unknown;
  throw new Error(`Unsupported import format: .${extension}`);
}

function parseDelimited(source: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted)
    throw new Error("Delimited file has an unterminated quoted field");
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers =
    rows
      .shift()
      ?.map((header, index) =>
        index === 0 ? header.replace(/^\uFEFF/, "").trim() : header.trim(),
      ) ?? [];
  if (headers.length === 0 || headers.some((header) => !header)) {
    throw new Error("Delimited file must have a header row with column names");
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error("Delimited file contains duplicate column names");
  }
  return rows
    .filter((values) => values.some((value) => value !== ""))
    .map((values) =>
      Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? ""]),
      ),
    );
}

function parseXml(source: string): unknown {
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.querySelector("parsererror")) {
    throw new Error(
      "Could not parse XML. Check that the document is well formed.",
    );
  }
  const root = document.documentElement;
  if (!root) throw new Error("XML document has no root element");
  return { [root.tagName]: xmlElementValue(root) };
}

function xmlElementValue(element: Element): unknown {
  const children = Array.from(element.children);
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
  if (children.length === 0 && element.attributes.length === 0) return text;

  const result: Record<string, unknown> = {};
  for (const attribute of Array.from(element.attributes)) {
    result[`@${attribute.name}`] = attribute.value;
  }
  for (const child of children) {
    const value = xmlElementValue(child);
    const current = result[child.tagName];
    if (current === undefined) result[child.tagName] = value;
    else if (Array.isArray(current)) current.push(value);
    else result[child.tagName] = [current, value];
  }
  if (text) result["#text"] = text;
  return result;
}

type RecordSource = {
  records: Record<string, unknown>[];
  selector: string;
};

function discoverRecords(
  value: unknown,
  path = ".",
  depth = 0,
): RecordSource | undefined {
  if (Array.isArray(value) && value.every(isRecord)) {
    return { records: value, selector: path === "." ? ".[]" : `${path}[]` };
  }
  if (!isRecord(value) || depth > 8) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const segment = /^[A-Za-z_][\w]*$/.test(key)
      ? `.${key}`
      : `.[${JSON.stringify(key)}]`;
    const found = discoverRecords(
      child,
      `${path === "." ? "" : path}${segment}`,
      depth + 1,
    );
    if (found) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordsAtRoot(value: unknown): RecordSource {
  const found = discoverRecords(value);
  if (found) return found;
  if (isRecord(value)) return { records: [value], selector: "." };
  throw new Error(
    "The file must contain a record object or an array of records.",
  );
}

export function inspectRecordSource(value: unknown): RecordSource {
  return recordsAtRoot(value);
}

function compatibleValue(type: string, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  switch (type) {
    case "integer":
    case "biginteger":
    case "relation":
    case "decimal":
    case "float":
      return (
        typeof value === "number" ||
        (typeof value === "string" && value.trim() !== "")
      );
    case "boolean":
      return (
        typeof value === "boolean" ||
        ["true", "false", "0", "1"].includes(String(value).toLowerCase())
      );
    case "json":
    case "media":
      return true;
    default:
      return typeof value === "string" || typeof value === "number";
  }
}

export function schemaMatchError(
  schema: ContentTypeSchema,
  records: Record<string, unknown>[],
): string | undefined {
  if (records.length === 0) return "The file contains no records.";
  const known = new Set([
    "id",
    "created_at",
    "updated_at",
    ...Object.keys(schema.attributes),
  ]);
  for (const [index, record] of records.entries()) {
    const unknown = Object.keys(record).find((key) => !known.has(key));
    if (unknown)
      return `Record ${index + 1} has an unknown field “${unknown}”.`;
    for (const [name, attribute] of Object.entries(schema.attributes)) {
      if (attribute.computed) continue;
      const value = record[name];
      if (
        attribute.required &&
        (value === undefined || value === null || value === "")
      ) {
        return `Record ${index + 1} is missing required field “${name}”.`;
      }
      if (value !== undefined && !compatibleValue(attribute.type, value)) {
        return `Record ${index + 1}, field “${name}”, has an incompatible value.`;
      }
    }
  }
  return undefined;
}

export function defaultJqMapping(
  root: unknown,
  schema: ContentTypeSchema,
): { expression: string; source: RecordSource } {
  const source = recordsAtRoot(root);
  const sample = source.records[0];
  const candidates: Array<{ key: string; path: string }> = [];
  const collect = (value: unknown, path: string, depth: number) => {
    if (!isRecord(value) || depth > 5) return;
    for (const [key, child] of Object.entries(value)) {
      const segment = /^[A-Za-z_][\w]*$/.test(key)
        ? `.${key}`
        : `.[${JSON.stringify(key)}]`;
      const childPath = `${path}${segment}`;
      if (isRecord(child)) collect(child, childPath, depth + 1);
      else if (!Array.isArray(child)) candidates.push({ key, path: childPath });
    }
  };
  collect(sample, "", 0);
  const properties = Object.keys(schema.attributes)
    .filter((name) => !schema.attributes[name].computed)
    .flatMap((name) => {
      const candidate = candidates.find(
        ({ key }) =>
          key === name ||
          key.toLowerCase().replace(/[^a-z0-9]/g, "") ===
            name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      );
      if (!candidate) return [];
      const target = /^[A-Za-z_][\w]*$/.test(name)
        ? name
        : JSON.stringify(name);
      return [`${target}: ${candidate.path || "."}`];
    });
  const expression = properties.length
    ? `${source.selector} | { ${properties.join(", ")} }`
    : `${source.selector} | {}`;
  return { expression, source };
}

function splitTopLevel(source: string, delimiter: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quote = "";
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (depth === 0 && source.startsWith(delimiter, index)) {
      result.push(source.slice(start, index).trim());
      start = index + delimiter.length;
      index += delimiter.length - 1;
    }
  }
  result.push(source.slice(start).trim());
  return result;
}

function evaluatePath(value: unknown, expression: string): unknown[] {
  if (!expression.startsWith("."))
    throw new Error(`Expected a jq-style path, got “${expression}”.`);
  let current = [value];
  let index = 1;
  while (index < expression.length) {
    if (expression[index] === ".") {
      index += 1;
      const start = index;
      while (
        index < expression.length &&
        /[A-Za-z0-9_]/.test(expression[index])
      )
        index += 1;
      if (start === index) throw new Error(`Invalid path: ${expression}`);
      const key = expression.slice(start, index);
      current = current.flatMap((item) =>
        isRecord(item) && key in item ? [item[key]] : [],
      );
      continue;
    }
    if (expression[index] === "[") {
      const end = expression.indexOf("]", index);
      if (end < 0) throw new Error(`Invalid path: ${expression}`);
      const selector = expression.slice(index + 1, end).trim();
      if (!selector) {
        current = current.flatMap((item) => (Array.isArray(item) ? item : []));
      } else if (/^\d+$/.test(selector)) {
        const selected = Number(selector);
        current = current.flatMap((item) =>
          Array.isArray(item) && selected in item ? [item[selected]] : [],
        );
      } else if (selector.startsWith('"')) {
        const key: unknown = JSON.parse(selector);
        current = current.flatMap((item) =>
          isRecord(item) && typeof key === "string" && key in item
            ? [item[key]]
            : [],
        );
      } else {
        throw new Error(`Unsupported path selector: [${selector}]`);
      }
      index = end + 1;
      continue;
    }
    throw new Error(`Invalid path: ${expression}`);
  }
  return current;
}

function evaluateAtom(value: unknown, expression: string): unknown[] {
  const fallback = splitTopLevel(expression, "//");
  if (fallback.length > 1) {
    const first = evaluateAtom(value, fallback[0]).filter(
      (item) => item !== null && item !== undefined,
    );
    return first.length
      ? first
      : evaluateAtom(value, fallback.slice(1).join(" // "));
  }
  if (expression === ".") return [value];
  if (expression.startsWith(".")) return evaluatePath(value, expression);
  if (expression.startsWith('"')) return [JSON.parse(expression) as unknown];
  if (expression.startsWith("'"))
    return [expression.slice(1, -1).replace(/\\'/g, "'")];
  if (expression === "null") return [null];
  if (expression === "true") return [true];
  if (expression === "false") return [false];
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(expression)) return [Number(expression)];
  throw new Error(`Unsupported jq expression “${expression}”.`);
}

function evaluateObject(
  value: unknown,
  expression: string,
): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(
      "Object mapping requires each selected value to be an object.",
    );
  const body = expression.slice(1, -1).trim();
  const result: Record<string, unknown> = {};
  if (!body) return result;
  for (const pair of splitTopLevel(body, ",")) {
    const colon = splitTopLevel(pair, ":");
    if (colon.length < 2) throw new Error(`Invalid object mapping: ${pair}`);
    let key = colon[0].trim();
    if (key.startsWith('"')) key = JSON.parse(key) as string;
    if (!/^[A-Za-z_][\w]*$/.test(key))
      throw new Error(`Invalid output field name: ${key}`);
    const values = evaluateAtom(value, colon.slice(1).join(":").trim());
    result[key] = values.length > 1 ? values : (values[0] ?? null);
  }
  return result;
}

export function applyJqMapping(
  root: unknown,
  expression: string,
): Record<string, unknown>[] {
  const stages = splitTopLevel(expression, "|").filter(Boolean);
  if (!stages.length) throw new Error("Enter a jq-style mapping expression.");
  let values: unknown[] = [root];
  for (const stage of stages) {
    if (stage.startsWith("{") && stage.endsWith("}")) {
      values = values.map((value) => evaluateObject(value, stage));
    } else {
      values = values.flatMap((value) => evaluateAtom(value, stage));
    }
  }
  if (values.length === 1 && Array.isArray(values[0])) values = values[0];
  if (!values.every(isRecord)) {
    throw new Error("The jq-style expression must produce record objects.");
  }
  return values;
}

export function serializeCsv(
  records: Record<string, unknown>[],
  initialHeaders: string[] = [],
): string {
  const headers = [
    ...new Set([
      ...initialHeaders,
      ...records.flatMap((record) => Object.keys(record)),
    ]),
  ];
  const quote = (value: unknown) => {
    const text =
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    headers,
    ...records.map((record) => headers.map((key) => record[key])),
  ]
    .map((values) => values.map(quote).join(","))
    .join("\r\n");
}

export function downloadContent(
  filename: string,
  content: string,
  mimeType: string,
) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
