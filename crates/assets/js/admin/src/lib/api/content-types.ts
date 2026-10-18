import { adminFetch } from "@/lib/fetch";

export type ContentTypeAttribute = {
  type: string;
  required?: boolean;
  unique?: boolean;
  private?: boolean;
  default?: unknown;
  min?: unknown;
  max?: unknown;
  minLength?: number;
  maxLength?: number;
  regex?: string;
  enumValues?: string[];
  relationTarget?: string;
  relationCardinality?: "manyToOne" | "manyToMany";
  attributes?: Record<string, ContentTypeAttribute> | null;
  targetField?: string;
  multiple?: boolean;
  allowedTypes?: string[];
  computed?: boolean;
  expression?: string;
  stored?: boolean;
  dependencies?: string[];
  rollup?: {
    relation: string;
    field: string;
    aggregate: "sum";
    stored: true;
  };
};

export type ContentTypeView = {
  id: string;
  name: string;
  type: "table" | "form";
  filter: string;
  sort: unknown[];
  columns: unknown[];
  isDefault: boolean;
};

export type ContentTypeViews = {
  version: 1;
  selectedViewId: string;
  views: ContentTypeView[];
};

export type ContentTypeSchema = {
  uid: string;
  kind: "collectionType" | "singleType";
  info: {
    singularName: string;
    pluralName: string;
    displayName: string;
    description?: string;
  };
  attributes: Record<string, ContentTypeAttribute>;
  views?: ContentTypeViews;
  tableName?: string;
  databaseSchema?: string;
};

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw Error(await response.text());
  }
  return (await response.json()) as T;
}

export async function listContentTypes(): Promise<ContentTypeSchema[]> {
  const response = await adminFetch("/content-types");
  return (await parseResponse<{ data: ContentTypeSchema[] }>(response)).data;
}

export async function createContentType(
  schema: Omit<ContentTypeSchema, "tableName">,
): Promise<ContentTypeSchema> {
  const response = await adminFetch("/content-types", {
    method: "POST",
    body: JSON.stringify(schema),
  });
  const created = (await parseResponse<{ data: ContentTypeSchema }>(response))
    .data;
  if (schema.views) {
    return updateContentTypeViews(created.uid, schema.views);
  }
  return created;
}

export async function updateContentType(
  uid: string,
  schema: Omit<ContentTypeSchema, "tableName">,
  renamedAttributes: Record<string, string> = {},
): Promise<ContentTypeSchema> {
  const response = await adminFetch(
    `/content-types/${encodeURIComponent(uid)}`,
    {
      method: "PUT",
      body: JSON.stringify({ ...schema, renamedAttributes }),
    },
  );
  return (await parseResponse<{ data: ContentTypeSchema }>(response)).data;
}

export async function deleteContentType(uid: string): Promise<void> {
  const response = await adminFetch(
    `/content-types/${encodeURIComponent(uid)}`,
    {
      method: "DELETE",
    },
  );
  await parseResponse(response);
}

export async function deleteContentTypes(uids: string[]): Promise<void> {
  const response = await adminFetch("/content-types", {
    method: "DELETE",
    body: JSON.stringify({ uids }),
  });
  await parseResponse(response);
}

export async function updateContentTypeViews(
  uid: string,
  views: ContentTypeViews,
): Promise<ContentTypeSchema> {
  const response = await adminFetch(
    `/content-types/${encodeURIComponent(uid)}/views`,
    {
      method: "PUT",
      body: JSON.stringify(views),
    },
  );
  return (await parseResponse<{ data: ContentTypeSchema }>(response)).data;
}
