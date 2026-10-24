import { For, Show, createSignal } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  TbOutlineDotsVertical,
  TbOutlineBraces,
  TbOutlineCalendar,
  TbOutlineClock,
  TbOutlineDatabase,
  TbOutlineDownload,
  TbOutlineEdit,
  TbOutlineFileText,
  TbOutlineAt,
  TbOutlineBlocks,
  TbOutlineKey,
  TbOutlineLetterA,
  TbOutlineLink,
  TbOutlineList,
  TbOutlineLockPassword,
  TbOutlineNumber123,
  TbOutlinePhoto,
  TbOutlinePlus,
  TbOutlineTrash,
  TbOutlineToggleRight,
  TbOutlineUpload,
} from "solid-icons/tb";
import { stringify as stringifyYaml } from "yaml";

import { Header } from "@/components/Header";
import { showToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MappingEditor } from "@/components/transfer/MappingEditor";
import { ContentTypeRecords } from "@/components/content-types/ContentTypeRecords";
import {
  useSidebar,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { TextField, TextFieldInput } from "@/components/ui/text-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createContentType,
  deleteContentType,
  deleteContentTypes,
  listContentTypes,
  updateContentType,
  type ContentTypeAttribute,
  type ContentTypeSchema,
} from "@/lib/api/content-types";
import {
  applyJqMapping,
  downloadContent,
  inspectRecordSource,
  parseImportDocument,
} from "@/lib/data-transfer";

function normalizeContentTypeBundle(
  value: unknown,
): ContentTypeSchema[] | undefined {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === "object" && "contentTypes" in value
      ? (value as { contentTypes: unknown }).contentTypes
      : undefined;
  if (!Array.isArray(candidate) || candidate.length === 0) return undefined;
  const definitions = candidate.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
  if (definitions.length !== candidate.length) return undefined;

  const compatible = definitions.every((item) => {
    const info = item.info as Record<string, unknown> | undefined;
    return (
      typeof info?.singularName === "string" &&
      item.attributes !== null &&
      typeof item.attributes === "object" &&
      !Array.isArray(item.attributes)
    );
  });
  if (!compatible) return undefined;

  // Accept content type definitions from different JSON/YAML producers. Fill
  // TrailBase's generated identity fields and normalize common field aliases
  // without depending on a particular export format.
  const slug = slugify;
  const infoOf = (item: Record<string, unknown>) =>
    item.info as {
      singularName: string;
      pluralName?: string;
      displayName?: string;
      description?: string;
    };
  const normalizeUid = (item: Record<string, unknown>, singular: string) => {
    const providedUid =
      typeof item.uid === "string" && item.uid.trim()
        ? item.uid.trim()
        : `api::${singular}.${singular}`;
    return providedUid
      .split(/(::|\.)/)
      .map((segment) => (/^(::|\.)$/.test(segment) ? segment : slug(segment)))
      .join("");
  };
  const uidBySourceUid = new Map<string, string>();
  for (const item of definitions) {
    const info = infoOf(item);
    const normalizedSingular = slug(info.singularName);
    const uid = normalizeUid(item, normalizedSingular);
    for (const externalUid of [
      item.uid,
      `api::${info.singularName}.${info.singularName}`,
      info.pluralName
        ? `api::${info.pluralName}.${info.pluralName}`
        : undefined,
    ]) {
      if (typeof externalUid === "string") uidBySourceUid.set(externalUid, uid);
    }
  }

  const normalizeAttribute = (value: unknown): ContentTypeAttribute => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { type: String(value ?? "string") };
    }
    const sourceAttribute = value as Record<string, unknown>;
    const {
      enum: enumValues,
      fieldType,
      target,
      relation,
      mappedBy: _mappedBy,
      inversedBy: _inversedBy,
      ...rest
    } = sourceAttribute;
    const attributeType =
      sourceAttribute.type === "enum"
        ? "enumeration"
        : String(sourceAttribute.type ?? fieldType ?? "string");
    const sourceTarget =
      typeof sourceAttribute.relationTarget === "string"
        ? sourceAttribute.relationTarget
        : target;
    const relationTarget =
      attributeType === "relation" && typeof sourceTarget === "string"
        ? (uidBySourceUid.get(sourceTarget) ?? sourceTarget)
        : undefined;
    const relationName = String(
      sourceAttribute.relationCardinality ?? relation ?? "",
    )
      .toLowerCase()
      .replaceAll(/[-_\s]/g, "");
    const relationCardinality =
      attributeType !== "relation"
        ? undefined
        : relationName === "manytomany"
          ? "manyToMany"
          : ["manytoone", "onetomany", "onetoone"].includes(relationName)
            ? "manyToOne"
            : undefined;
    const nestedSource = sourceAttribute.attributes;
    const nestedAttributes =
      nestedSource &&
      typeof nestedSource === "object" &&
      !Array.isArray(nestedSource)
        ? Object.fromEntries(
            Object.entries(nestedSource).map(([name, attribute]) => [
              slug(name),
              normalizeAttribute(attribute),
            ]),
          )
        : undefined;
    const generatedExpression =
      typeof rest.expression === "string" ? rest.expression.trim() : "";
    const rollup =
      rest.rollup &&
      typeof rest.rollup === "object" &&
      !Array.isArray(rest.rollup)
        ? (rest.rollup as Record<string, unknown>)
        : undefined;
    const keepRollup =
      rest.computed === true &&
      typeof rollup?.relation === "string" &&
      typeof rollup.field === "string" &&
      (rollup.aggregate === undefined || rollup.aggregate === "sum") &&
      (rollup.stored === undefined || rollup.stored === true);
    // The server validates the supported expression grammar. Preserve SQL
    // functions here so valid generated formulas survive import/export.
    const keepComputed =
      rest.computed === true && (keepRollup || generatedExpression.length > 0);

    return {
      ...rest,
      type: attributeType,
      ...(Array.isArray(rest.enumValues)
        ? {}
        : Array.isArray(enumValues)
          ? { enumValues }
          : {}),
      ...(relationTarget ? { relationTarget } : {}),
      ...(relationCardinality ? { relationCardinality } : {}),
      ...(nestedAttributes ? { attributes: nestedAttributes } : {}),
      ...(keepComputed
        ? { computed: true }
        : {
            computed: undefined,
            expression: undefined,
            stored: undefined,
            dependencies: undefined,
            rollup: undefined,
          }),
    } as ContentTypeAttribute;
  };

  return definitions.map((item) => {
    const info = infoOf(item);
    const normalizedSingular = slug(info.singularName);
    const sourceAttributes = item.attributes as Record<string, unknown>;
    const attributes = Object.fromEntries(
      Object.entries(sourceAttributes).map(([name, value]) => [
        slug(name),
        normalizeAttribute(value),
      ]),
    );
    const normalizedPlural = slug(
      info.pluralName ?? pluralize(normalizedSingular),
    );
    return {
      uid: normalizeUid(item, normalizedSingular),
      kind: item.kind === "singleType" ? "singleType" : "collectionType",
      info: {
        ...info,
        singularName: normalizedSingular,
        pluralName: normalizedPlural,
        displayName:
          info.displayName ??
          normalizedSingular
            .split("_")
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" "),
      },
      attributes,
    } as ContentTypeSchema;
  });
}

type FieldDraft = {
  name: string;
  type: string;
  required: boolean;
  unique: boolean;
  enumValues: string;
  relationTarget: string;
  relationCardinality: "manyToOne" | "manyToMany";
  relationAttributes: Record<string, ContentTypeAttribute>;
  computed: boolean;
  expression: string;
  stored: boolean;
  private: boolean;
  defaultValue: string;
  defaultMode: "value" | "sqlView";
  defaultSql: string;
  rollup?: ContentTypeAttribute["rollup"];
  min: string;
  max: string;
  minLength: string;
  maxLength: string;
  regex: string;
  targetField: string;
  multiple: boolean;
  allowedTypes: string[];
};
type ModalState =
  | { kind: "metadata"; uid?: string }
  | { kind: "field"; name?: string }
  | { kind: "import" }
  | { kind: "export" }
  | null;

const inputStyle =
  "border-input bg-background h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const fieldTypeOptions = [
  {
    type: "string",
    label: "Text",
    description: "Short or long text values",
  },
  {
    type: "boolean",
    label: "Boolean",
    description: "Yes or no, true or false",
  },
  {
    type: "richtext",
    label: "Rich text (Blocks)",
    description: "Structured rich text content",
  },
  {
    type: "json",
    label: "JSON",
    description: "Structured data in JSON format",
  },
  {
    type: "decimal",
    label: "Number",
    description: "Integer or decimal values",
  },
  { type: "email", label: "Email", description: "An email address" },
  { type: "date", label: "Date", description: "A calendar date" },
  {
    type: "password",
    label: "Password",
    description: "A password value",
  },
  {
    type: "media",
    label: "Media",
    description: "JSON file or media references",
  },
  {
    type: "enumeration",
    label: "Enumeration",
    description: "Choose from a fixed list of values",
  },
  {
    type: "relation",
    label: "Relation",
    description: "Reference another collection type",
  },
  {
    type: "uid",
    label: "UID",
    description: "A unique text identifier",
  },
  {
    type: "richtext_markdown",
    label: "Rich text (Markdown)",
    description: "Markdown formatted text",
  },
];

function ContentTypePickerItems(props: {
  schemas: ContentTypeSchema[];
  selectedUid: string | undefined;
  selectedUids: string[];
  onSelect: (uid: string) => void;
  onToggleSelection: (uid: string, checked: boolean) => void;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <For each={props.schemas}>
      {(schema) => (
        <SidebarMenuItem class="flex items-center gap-1">
          <Checkbox
            class="ml-2"
            aria-label={`Select ${schema.info.displayName}`}
            checked={props.selectedUids.includes(schema.uid)}
            onChange={(checked) => props.onToggleSelection(schema.uid, checked)}
          />
          <SidebarMenuButton
            class="min-w-0 flex-1"
            isActive={props.selectedUid === schema.uid}
            tooltip={schema.info.displayName}
            onClick={() => {
              props.onSelect(schema.uid);
              setOpenMobile(false);
            }}
          >
            <TbOutlineDatabase />
            <span class="truncate">{schema.info.displayName}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </For>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pluralize(value: string): string {
  if (!value) return "";
  if (/[^aeiou]y$/.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(value)) return `${value}es`;
  return `${value}s`;
}

function fieldTypeLabel(type: string): string {
  switch (type) {
    case "string":
      return "Text";
    case "text":
      return "Long text";
    case "time":
      return "Time";
    case "richtext":
      return "Rich text (Blocks)";
    case "richtext_markdown":
      return "Rich text (Markdown)";
    case "integer":
      return "Integer";
    case "biginteger":
      return "Big integer";
    case "decimal":
      return "Decimal";
    case "float":
      return "Float";
    case "datetime":
      return "Date and time";
    case "json":
      return "JSON";
    case "boolean":
      return "Boolean";
    case "uid":
      return "UID";
    case "media":
      return "Media";
    case "enumeration":
      return "Enumeration";
    case "relation":
      return "Relation";
    case "password":
      return "Password";
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

function supportsGenerated(type: string): boolean {
  return [
    "integer",
    "biginteger",
    "decimal",
    "float",
    "string",
    "text",
    "boolean",
    "date",
    "datetime",
  ].includes(type);
}

function parseDefaultValue(type: string, rawValue: string): unknown {
  const value = rawValue.trim();
  if (!value) return undefined;
  if (["integer", "biginteger", "decimal", "float"].includes(type)) {
    return Number(value);
  }
  if (type === "boolean") return value === "true" || value === "1";
  if (type === "json" || type === "media") {
    return JSON.parse(value) as unknown;
  }
  return rawValue;
}

function sqlViewDefaultSql(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "sqlView" &&
    typeof (value as Record<string, unknown>).sql === "string"
  ) {
    return (value as { sql: string }).sql;
  }
  return undefined;
}

function hasSqlViewDefault(attribute: ContentTypeAttribute): boolean {
  return (
    sqlViewDefaultSql(attribute.default) !== undefined ||
    Object.values(attribute.attributes ?? {}).some(hasSqlViewDefault)
  );
}

function withoutSqlViewDefaults(
  attribute: ContentTypeAttribute,
): ContentTypeAttribute {
  const { default: defaultValue, ...withoutDefault } = attribute;
  const result =
    sqlViewDefaultSql(defaultValue) === undefined ? attribute : withoutDefault;
  if (!attribute.attributes) return result;
  return {
    ...result,
    attributes: Object.fromEntries(
      Object.entries(attribute.attributes).map(([name, child]) => [
        name,
        withoutSqlViewDefaults(child),
      ]),
    ),
  };
}

function literalDefaultValue(value: unknown): string {
  if (value === undefined || sqlViewDefaultSql(value) !== undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function FieldTypeIcon(props: { type: string }) {
  const icons = {
    boolean: TbOutlineToggleRight,
    richtext: TbOutlineBlocks,
    json: TbOutlineBraces,
    integer: TbOutlineNumber123,
    biginteger: TbOutlineNumber123,
    decimal: TbOutlineNumber123,
    float: TbOutlineNumber123,
    email: TbOutlineAt,
    date: TbOutlineCalendar,
    datetime: TbOutlineCalendar,
    time: TbOutlineClock,
    password: TbOutlineLockPassword,
    media: TbOutlinePhoto,
    enumeration: TbOutlineList,
    relation: TbOutlineLink,
    uid: TbOutlineKey,
    richtext_markdown: TbOutlineFileText,
  };
  return (
    <Dynamic
      component={icons[props.type as keyof typeof icons] ?? TbOutlineLetterA}
    />
  );
}

function FieldTypeBadge(props: { type: string; large?: boolean }) {
  const colorClass = () => {
    switch (props.type) {
      case "string":
      case "text":
      case "boolean":
        return "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400";
      case "richtext":
      case "json":
        return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400";
      case "decimal":
      case "float":
      case "integer":
      case "biginteger":
      case "email":
        return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";
      case "date":
      case "datetime":
      case "time":
      case "password":
        return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
      case "media":
      case "enumeration":
        return "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400";
      case "relation":
      case "uid":
        return "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400";
      case "richtext_markdown":
        return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400";
      default:
        return "border-primary/20 bg-primary/5 text-primary";
    }
  };
  const sizeClass = () => (props.large ? "size-10" : "size-9");
  return (
    <span
      class={`flex ${sizeClass()} shrink-0 items-center justify-center rounded-sm border ${colorClass()}`}
      aria-hidden="true"
    >
      <span class={props.large ? "size-5 text-xl" : "size-4 text-base"}>
        <FieldTypeIcon type={props.type} />
      </span>
    </span>
  );
}

export function ContentTypesPage() {
  const queryClient = useQueryClient();
  const contentTypes = useQuery(() => ({
    queryKey: ["content-types"],
    queryFn: listContentTypes,
  }));
  const [selectedUid, setSelectedUid] = createSignal<string>();
  const [selectedUids, setSelectedUids] = createSignal<string[]>([]);
  const [exportUids, setExportUids] = createSignal<string[] | undefined>();
  const [sidebarWidth, setSidebarWidth] = createSignal(224);
  const [activeTab, setActiveTab] = createSignal<
    "fields" | "views" | "settings"
  >("fields");
  const [search, setSearch] = createSignal("");
  const [modal, setModal] = createSignal<ModalState>(null);
  const [displayName, setDisplayName] = createSignal("");
  const [uid, setUid] = createSignal("");
  const [singularName, setSingularName] = createSignal("");
  const [pluralName, setPluralName] = createSignal("");
  const [uidEdited, setUidEdited] = createSignal(false);
  const [singularEdited, setSingularEdited] = createSignal(false);
  const [pluralEdited, setPluralEdited] = createSignal(false);
  const [fieldDraft, setFieldDraft] = createSignal<FieldDraft>({
    name: "",
    type: "string",
    required: false,
    unique: false,
    enumValues: "",
    relationTarget: "",
    relationCardinality: "manyToOne",
    relationAttributes: {},
    computed: false,
    expression: "",
    stored: true,
    private: false,
    defaultValue: "",
    defaultMode: "value",
    defaultSql: "",
    min: "",
    max: "",
    minLength: "",
    maxLength: "",
    regex: "",
    targetField: "",
    multiple: false,
    allowedTypes: [],
  });
  const [fieldStep, setFieldStep] = createSignal<"select" | "configure">(
    "select",
  );
  const [error, setError] = createSignal<string>();
  const [pageError, setPageError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [transferBusy, setTransferBusy] = createSignal(false);
  const [importFileName, setImportFileName] = createSignal("");
  const [importDefinitions, setImportDefinitions] = createSignal<
    ContentTypeSchema[]
  >([]);
  const [definitionMappingRequired, setDefinitionMappingRequired] =
    createSignal(false);
  const [definitionMapping, setDefinitionMapping] = createSignal("");
  const [definitionMappingError, setDefinitionMappingError] =
    createSignal<string>();
  const [definitionImportRoot, setDefinitionImportRoot] =
    createSignal<unknown>();
  const [exportFormat, setExportFormat] = createSignal<"json" | "yaml">("json");
  let importFileInput!: HTMLInputElement;

  const selectedSchema = () =>
    contentTypes.data?.find((schema) => schema.uid === selectedUid());
  const visibleSchemas = () =>
    (contentTypes.data ?? []).filter((schema) =>
      `${schema.info.displayName} ${schema.uid}`
        .toLowerCase()
        .includes(search().toLowerCase()),
    );
  const visibleSelectionState = () => {
    const visible = visibleSchemas();
    const selectedCount = visible.filter((schema) =>
      selectedUids().includes(schema.uid),
    ).length;
    return visible.length > 0 && selectedCount === visible.length;
  };
  const editingSchema = () => {
    const current = modal();
    return current?.kind === "metadata" && current.uid
      ? contentTypes.data?.find((schema) => schema.uid === current.uid)
      : undefined;
  };

  function resetMetadata() {
    setDisplayName("");
    setUid("");
    setSingularName("");
    setPluralName("");
    setUidEdited(false);
    setSingularEdited(false);
    setPluralEdited(false);
  }

  function closeModal() {
    if (busy() || transferBusy()) return;
    setModal(null);
    setExportUids(undefined);
    setError(undefined);
  }

  function openCreateModal() {
    resetMetadata();
    setError(undefined);
    setModal({ kind: "metadata" });
  }

  function openEditModal(schema: ContentTypeSchema) {
    setDisplayName(schema.info.displayName);
    setUid(schema.uid);
    setSingularName(schema.info.singularName);
    setPluralName(schema.info.pluralName);
    // Existing API identifiers are treated as explicit values while editing.
    setUidEdited(true);
    setSingularEdited(true);
    setPluralEdited(true);
    setError(undefined);
    setModal({ kind: "metadata", uid: schema.uid });
  }

  function updateGeneratedNames(name: string) {
    const base = slugify(name);
    if (!uidEdited()) setUid(base);
    if (!singularEdited()) setSingularName(base);
    if (!pluralEdited()) setPluralName(pluralize(base));
  }

  function openFieldModal(name?: string) {
    const schema = selectedSchema();
    const attribute = name ? schema?.attributes[name] : undefined;
    setFieldDraft(
      attribute
        ? {
            name: name ?? "",
            type: attribute.type,
            required: attribute.required ?? false,
            unique: attribute.unique ?? false,
            enumValues: (attribute.enumValues ?? []).join("\n"),
            relationTarget: attribute.relationTarget ?? "",
            relationCardinality: attribute.relationCardinality ?? "manyToOne",
            relationAttributes: attribute.attributes ?? {},
            computed: attribute.computed ?? false,
            expression: attribute.expression ?? "",
            stored: attribute.stored ?? true,
            private: attribute.private ?? false,
            defaultValue: literalDefaultValue(attribute.default),
            defaultMode:
              sqlViewDefaultSql(attribute.default) === undefined
                ? "value"
                : "sqlView",
            defaultSql: sqlViewDefaultSql(attribute.default) ?? "",
            rollup: attribute.rollup,
            min: attribute.min === undefined ? "" : String(attribute.min),
            max: attribute.max === undefined ? "" : String(attribute.max),
            minLength:
              attribute.minLength === undefined
                ? ""
                : String(attribute.minLength),
            maxLength:
              attribute.maxLength === undefined
                ? ""
                : String(attribute.maxLength),
            regex: attribute.regex ?? "",
            targetField: attribute.targetField ?? "",
            multiple: attribute.multiple ?? false,
            allowedTypes: attribute.allowedTypes ?? [],
          }
        : {
            name: "",
            type: "string",
            required: false,
            unique: false,
            enumValues: "",
            relationTarget: "",
            relationCardinality: "manyToOne",
            relationAttributes: {},
            computed: false,
            expression: "",
            stored: true,
            private: false,
            defaultValue: "",
            defaultMode: "value",
            defaultSql: "",
            min: "",
            max: "",
            minLength: "",
            maxLength: "",
            regex: "",
            targetField: "",
            multiple: false,
            allowedTypes: [],
          },
    );
    setFieldStep(name ? "configure" : "select");
    setError(undefined);
    setModal({ kind: "field", name });
  }

  async function saveMetadata() {
    setError(undefined);
    if (!displayName().trim() || !uid() || !singularName() || !pluralName()) {
      setError(
        "Fill in the display name, UID, singular name, and plural name.",
      );
      return;
    }

    setBusy(true);
    try {
      const current = editingSchema();
      const request = {
        uid: uid(),
        kind: current?.kind ?? "collectionType",
        info: {
          displayName: displayName().trim(),
          singularName: singularName(),
          pluralName: pluralName(),
        },
        attributes: current?.attributes ?? {},
      };
      const schema = current
        ? await updateContentType(current.uid, request)
        : await createContentType(request);
      await queryClient.invalidateQueries({ queryKey: ["content-types"] });
      setSelectedUid(schema.uid);
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function persistAttributes(
    attributes: Record<string, ContentTypeAttribute>,
    renamedAttributes: Record<string, string> = {},
  ) {
    const schema = selectedSchema();
    if (!schema) return;
    setError(undefined);
    setBusy(true);
    try {
      const updated = await updateContentType(
        schema.uid,
        {
          uid: schema.uid,
          kind: schema.kind,
          info: schema.info,
          attributes,
        },
        renamedAttributes,
      );
      await queryClient.invalidateQueries({ queryKey: ["content-types"] });
      setSelectedUid(updated.uid);
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function updateRelationAttribute(
    name: string,
    update: Partial<ContentTypeAttribute>,
    nextName = name,
  ) {
    const attributes = { ...fieldDraft().relationAttributes };
    const attribute = attributes[name];
    if (!attribute) return;
    delete attributes[name];
    attributes[nextName || name] = { ...attribute, ...update };
    setFieldDraft({ ...fieldDraft(), relationAttributes: attributes });
  }

  function addRelationAttribute() {
    const attributes = { ...fieldDraft().relationAttributes };
    let index = Object.keys(attributes).length + 1;
    let name = `attribute_${index}`;
    while (attributes[name]) name = `attribute_${++index}`;
    attributes[name] = { type: "string", required: false, computed: false };
    setFieldDraft({ ...fieldDraft(), relationAttributes: attributes });
  }

  async function saveField() {
    const current = modal();
    const schema = selectedSchema();
    if (!schema || current?.kind !== "field") return;
    const name = slugify(fieldDraft().name);
    if (!name) {
      setError("Enter a field name.");
      return;
    }
    if (name !== current.name && schema.attributes[name]) {
      setError(`A field named “${name}” already exists.`);
      return;
    }
    if (fieldDraft().type === "enumeration") {
      const values = fieldDraft()
        .enumValues.split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      if (values.length === 0 || new Set(values).size !== values.length) {
        setError("Add at least one unique value for this enumeration.");
        return;
      }
    }
    if (fieldDraft().type === "relation" && !fieldDraft().relationTarget) {
      setError("Choose a collection type for this relation.");
      return;
    }
    if (
      fieldDraft().type === "relation" &&
      fieldDraft().relationCardinality === "manyToMany"
    ) {
      const relationAttributes = Object.entries(
        fieldDraft().relationAttributes,
      );
      const names = relationAttributes.map(([attributeName]) =>
        slugify(attributeName),
      );
      if (names.some((attributeName) => !attributeName)) {
        setError("Enter a name for each relation attribute.");
        return;
      }
      if (new Set(names).size !== names.length) {
        setError("Relation attribute names must be unique.");
        return;
      }
      if (
        relationAttributes.some(
          ([, attribute]) =>
            attribute.computed && !attribute.expression?.trim(),
        )
      ) {
        setError("Enter an expression for each generated relation attribute.");
        return;
      }
      if (
        relationAttributes.some(([, attribute]) => {
          if (
            attribute.default === undefined ||
            attribute.computed ||
            sqlViewDefaultSql(attribute.default) !== undefined
          ) {
            return false;
          }
          if (
            ["integer", "biginteger", "decimal", "float"].includes(
              attribute.type,
            )
          ) {
            return (
              typeof attribute.default !== "number" ||
              !Number.isFinite(attribute.default)
            );
          }
          return false;
        })
      ) {
        setError("Enter a valid default value for each relation attribute.");
        return;
      }
    }
    if (
      fieldDraft().computed &&
      !fieldDraft().rollup &&
      !fieldDraft().expression.trim()
    ) {
      setError("Enter an expression for the generated field.");
      return;
    }
    if (
      fieldDraft().defaultMode === "sqlView" &&
      !fieldDraft().computed &&
      !fieldDraft().defaultSql.trim()
    ) {
      setError("Enter a SELECT query for the SQL view default.");
      return;
    }
    if (
      fieldDraft().defaultMode === "value" &&
      ["integer", "biginteger", "decimal", "float"].includes(
        fieldDraft().type,
      ) &&
      fieldDraft().defaultValue.trim() &&
      !Number.isFinite(Number(fieldDraft().defaultValue))
    ) {
      setError("Enter a valid numeric default value.");
      return;
    }
    if (
      fieldDraft().defaultMode === "value" &&
      ["json", "media"].includes(fieldDraft().type) &&
      fieldDraft().defaultValue.trim()
    ) {
      try {
        JSON.parse(fieldDraft().defaultValue);
      } catch {
        setError("Enter a valid JSON default value.");
        return;
      }
    }
    if (fieldDraft().minLength && fieldDraft().maxLength) {
      if (Number(fieldDraft().minLength) > Number(fieldDraft().maxLength)) {
        setError(
          "Minimum length must be less than or equal to maximum length.",
        );
        return;
      }
    }
    const attributes = { ...schema.attributes };
    if (current.name) delete attributes[current.name];
    const relationAttributes = Object.fromEntries(
      Object.entries(fieldDraft().relationAttributes).map(
        ([attributeName, attribute]) => [slugify(attributeName), attribute],
      ),
    );
    attributes[name] = {
      type: fieldDraft().type,
      required: fieldDraft().computed ? false : fieldDraft().required,
      unique: fieldDraft().computed
        ? false
        : fieldDraft().type === "uid" || fieldDraft().unique,
      private: fieldDraft().private,
      ...(!fieldDraft().computed && fieldDraft().defaultMode === "sqlView"
        ? {
            default: {
              type: "sqlView",
              sql: fieldDraft().defaultSql.trim(),
            },
          }
        : fieldDraft().defaultValue.trim() && !fieldDraft().computed
          ? {
              default: parseDefaultValue(
                fieldDraft().type,
                fieldDraft().defaultValue,
              ),
            }
          : {}),
      ...(fieldDraft().min.trim()
        ? {
            min: Number.isFinite(Number(fieldDraft().min))
              ? Number(fieldDraft().min)
              : fieldDraft().min,
          }
        : {}),
      ...(fieldDraft().max.trim()
        ? {
            max: Number.isFinite(Number(fieldDraft().max))
              ? Number(fieldDraft().max)
              : fieldDraft().max,
          }
        : {}),
      ...(fieldDraft().minLength.trim()
        ? { minLength: Number(fieldDraft().minLength) }
        : {}),
      ...(fieldDraft().maxLength.trim()
        ? { maxLength: Number(fieldDraft().maxLength) }
        : {}),
      ...(fieldDraft().regex.trim() ? { regex: fieldDraft().regex } : {}),
      ...(fieldDraft().type === "uid" && fieldDraft().targetField
        ? { targetField: fieldDraft().targetField }
        : {}),
      ...(fieldDraft().type === "media"
        ? {
            multiple: fieldDraft().multiple,
            allowedTypes: fieldDraft().allowedTypes,
          }
        : {}),
      computed: fieldDraft().computed,
      ...(fieldDraft().computed
        ? {
            stored: fieldDraft().stored,
            ...(fieldDraft().rollup
              ? { rollup: fieldDraft().rollup }
              : { expression: fieldDraft().expression.trim() }),
          }
        : {}),
      ...(fieldDraft().type === "enumeration"
        ? {
            enumValues: fieldDraft()
              .enumValues.split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
          }
        : {}),
      ...(fieldDraft().type === "relation"
        ? {
            relationTarget: fieldDraft().relationTarget,
            relationCardinality: fieldDraft().relationCardinality,
            ...(fieldDraft().relationCardinality === "manyToMany" &&
            Object.keys(relationAttributes).length > 0
              ? { attributes: relationAttributes }
              : { attributes: null }),
          }
        : {}),
    };
    await persistAttributes(
      attributes,
      current.name && current.name !== name ? { [current.name]: name } : {},
    );
  }

  async function removeField(name: string) {
    const schema = selectedSchema();
    if (!schema) return;
    if (
      !window.confirm(
        `Delete the “${name}” field and all of its stored values?`,
      )
    )
      return;
    const attributes = { ...schema.attributes };
    delete attributes[name];
    setPageError(undefined);
    setBusy(true);
    try {
      await updateContentType(schema.uid, {
        uid: schema.uid,
        kind: schema.kind,
        info: schema.info,
        attributes,
      });
      await queryClient.invalidateQueries({ queryKey: ["content-types"] });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(schema: ContentTypeSchema) {
    if (
      !window.confirm(
        `Delete “${schema.info.displayName}” and all of its records?`,
      )
    )
      return;
    setPageError(undefined);
    try {
      await deleteContentType(schema.uid);
      if (selectedUid() === schema.uid) setSelectedUid(undefined);
      await queryClient.invalidateQueries({ queryKey: ["content-types"] });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeSelected() {
    const allSchemas = contentTypes.data ?? [];
    const selected = allSchemas.filter((schema) =>
      selectedUids().includes(schema.uid),
    );
    if (selected.length === 0) return;
    const names = selected.map((schema) => schema.info.displayName).join(", ");
    if (
      !window.confirm(
        `Delete ${selected.length} content type${selected.length === 1 ? "" : "s"} (${names}) and all of their records?`,
      )
    )
      return;

    setPageError(undefined);
    setBusy(true);
    try {
      await deleteContentTypes(selected.map((schema) => schema.uid));
      if (selected.some((schema) => schema.uid === selectedUid())) {
        setSelectedUid(undefined);
      }
      setSelectedUids([]);
      await queryClient.invalidateQueries({ queryKey: ["content-types"] });
      showToast({
        title: "Content types deleted",
        description: `Deleted ${selected.length} content types.`,
      });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadImportFile(file: File) {
    setError(undefined);
    setPageError(undefined);
    try {
      const root = parseImportDocument(await file.text(), file.name);
      setDefinitionImportRoot(root);
      const bundle = normalizeContentTypeBundle(root);
      if (bundle) {
        setImportDefinitions(bundle);
        setDefinitionMappingRequired(false);
        setDefinitionMapping("");
        setDefinitionMappingError(undefined);
      } else {
        let selector = ".";
        try {
          selector = inspectRecordSource(root).selector;
        } catch {
          // Keep the mapping editor available for unusual but parseable shapes.
        }
        setDefinitionMappingRequired(true);
        setDefinitionMapping(selector);
        try {
          const mapped = applyJqMapping(root, selector);
          const mappedBundle = normalizeContentTypeBundle(mapped);
          if (!mappedBundle) {
            throw new Error(
              "Mapping must produce content type definitions with uid, kind, info, and attributes.",
            );
          }
          setImportDefinitions(mappedBundle);
          setDefinitionMappingError(undefined);
        } catch (err) {
          setImportDefinitions([]);
          setDefinitionMappingError(
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      setImportFileName(file.name);
      setModal({ kind: "import" });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    }
  }

  function updateDefinitionMapping(expression: string) {
    setDefinitionMapping(expression);
    try {
      const mapped = applyJqMapping(definitionImportRoot(), expression);
      const bundle = normalizeContentTypeBundle(mapped);
      if (!bundle) {
        throw new Error(
          "Mapping must produce content type definitions with uid, kind, info, and attributes.",
        );
      }
      setImportDefinitions(bundle);
      setDefinitionMappingError(undefined);
    } catch (err) {
      setImportDefinitions([]);
      setDefinitionMappingError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function runImport() {
    if (transferBusy()) return;
    setError(undefined);
    setTransferBusy(true);
    try {
      const definitions = importDefinitions();
      const definitionsWithDeferredFields: ContentTypeSchema[] = [];
      const definitionsWithSqlDefaults: ContentTypeSchema[] = [];
      for (const item of definitions) {
        const {
          tableName: _tableName,
          databaseSchema: _databaseSchema,
          ...definition
        } = item;
        const deferredAttributes = Object.fromEntries(
          Object.entries(definition.attributes).filter(
            ([, attribute]) =>
              attribute.type === "relation" ||
              attribute.computed === true ||
              sqlViewDefaultSql(attribute.default) !== undefined,
          ),
        );
        const attributes = Object.fromEntries(
          Object.entries(definition.attributes).filter(
            ([, attribute]) =>
              attribute.type !== "relation" &&
              attribute.computed !== true &&
              sqlViewDefaultSql(attribute.default) === undefined,
          ),
        );
        await createContentType({ ...definition, attributes });
        if (Object.keys(deferredAttributes).length > 0) {
          definitionsWithDeferredFields.push({
            ...definition,
            attributes: Object.fromEntries(
              Object.entries({ ...attributes, ...deferredAttributes }).map(
                ([name, attribute]) => [
                  name,
                  withoutSqlViewDefaults(attribute),
                ],
              ),
            ),
          });
        }
        if (Object.values(definition.attributes).some(hasSqlViewDefault)) {
          definitionsWithSqlDefaults.push(definition);
        }
      }
      // Create every relation table and generated field before installing SQL
      // defaults. SQL-default triggers may query other relation tables, so all
      // of those tables must exist before SQLite compiles the trigger bodies.
      for (const definition of definitionsWithDeferredFields) {
        await updateContentType(definition.uid, {
          uid: definition.uid,
          kind: definition.kind,
          info: definition.info,
          attributes: definition.attributes,
        });
      }
      // Install SQL defaults last so cross-content-type queries in defaults can
      // safely reference relations whose definitions occur later in the file.
      for (const definition of definitionsWithSqlDefaults) {
        await updateContentType(definition.uid, {
          uid: definition.uid,
          kind: definition.kind,
          info: definition.info,
          attributes: definition.attributes,
        });
      }
      setModal(null);
      await queryClient.invalidateQueries({ queryKey: ["content-types"] });
      showToast({
        title: "Import complete",
        description: `Imported ${importDefinitions().length} content types.`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusy(false);
    }
  }

  function exportDefinitions() {
    const selectedForExport = exportUids();
    const definitions = (contentTypes.data ?? [])
      .filter(
        (schema) =>
          !selectedForExport || selectedForExport.includes(schema.uid),
      )
      .map(
        ({
          tableName: _tableName,
          databaseSchema: _databaseSchema,
          ...definition
        }) => definition,
      );
    const bundle = {
      format: "trailbase-content-types",
      version: 1,
      contentTypes: definitions,
    };
    const yaml = exportFormat() === "yaml";
    downloadContent(
      `trailbase-content-types.${yaml ? "yaml" : "json"}`,
      yaml ? stringifyYaml(bundle) : `${JSON.stringify(bundle, null, 2)}\n`,
      yaml
        ? "application/yaml;charset=utf-8"
        : "application/json;charset=utf-8",
    );
    setModal(null);
    setExportUids(undefined);
    showToast({
      title: "Export complete",
      description: `Exported ${definitions.length} content types.`,
    });
  }

  const isMetadataModal = () => modal()?.kind === "metadata";
  const isFieldModal = () => modal()?.kind === "field";
  const isImportModal = () => modal()?.kind === "import";
  const isExportModal = () => modal()?.kind === "export";
  const isEditingMetadata = () => editingSchema() !== undefined;
  const fieldModalName = () => {
    const current = modal();
    return current?.kind === "field" ? current.name : undefined;
  };

  return (
    <Dialog
      open={modal() !== null}
      modal={true}
      onOpenChange={(open) => {
        if (!open) closeModal();
      }}
    >
      <div class="size-full min-h-0">
        <SidebarProvider
          class="h-full min-h-0"
          style={{ "--sidebar-width": `${sidebarWidth()}px` }}
        >
          <Sidebar
            class="absolute"
            variant="sidebar"
            side="left"
            collapsible="offcanvas"
          >
            <SidebarHeader class="gap-3 p-3">
              <input
                ref={importFileInput}
                type="file"
                accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                class="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void loadImportFile(file);
                }}
              />
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="font-semibold">Content Types</div>
                  <div class="text-muted-foreground text-xs">
                    {contentTypes.data?.length ?? 0} types
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Create content type"
                    onClick={openCreateModal}
                  >
                    <TbOutlinePlus />
                  </Button>
                  <DropdownMenu placement="bottom-end">
                    <DropdownMenuTrigger
                      class={buttonVariants({ variant: "ghost", size: "icon" })}
                      aria-label="Content type actions"
                      disabled={transferBusy() || busy()}
                    >
                      <TbOutlineDotsVertical />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        onSelect={() => importFileInput.click()}
                      >
                        <TbOutlineUpload /> Import types
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          setExportUids(undefined);
                          setExportFormat("json");
                          setModal({ kind: "export" });
                        }}
                      >
                        <TbOutlineDownload /> Export all types
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={selectedUids().length === 0}
                        onSelect={() => {
                          setExportUids([...selectedUids()]);
                          setExportFormat("json");
                          setModal({ kind: "export" });
                        }}
                      >
                        <TbOutlineDownload /> Export selected (
                        {selectedUids().length})
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        class="text-destructive"
                        disabled={selectedUids().length === 0 || busy()}
                        onSelect={() => void removeSelected()}
                      >
                        <TbOutlineTrash /> Delete selected (
                        {selectedUids().length})
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <TextField>
                <TextFieldInput
                  type="text"
                  aria-label="Search content types"
                  placeholder="Search content types…"
                  value={search()}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
              </TextField>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup class="pt-0">
                <SidebarGroupLabel class="flex items-center justify-between">
                  <span>Collections</span>
                  <Checkbox
                    aria-label="Select all visible content types"
                    title="Select all visible content types"
                    disabled={visibleSchemas().length === 0}
                    checked={visibleSelectionState()}
                    onChange={(checked) => {
                      const visibleUids = visibleSchemas().map(
                        (schema) => schema.uid,
                      );
                      setSelectedUids((current) =>
                        checked
                          ? [...new Set([...current, ...visibleUids])]
                          : current.filter((uid) => !visibleUids.includes(uid)),
                      );
                    }}
                  />
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <Show when={contentTypes.isPending}>
                    <div class="text-muted-foreground px-3 py-2 text-sm">
                      Loading content types…
                    </div>
                  </Show>
                  <SidebarMenu>
                    <ContentTypePickerItems
                      schemas={visibleSchemas()}
                      selectedUid={selectedUid()}
                      selectedUids={selectedUids()}
                      onToggleSelection={(nextUid, checked) =>
                        setSelectedUids((current) =>
                          checked
                            ? [...new Set([...current, nextUid])]
                            : current.filter((item) => item !== nextUid),
                        )
                      }
                      onSelect={(nextUid) => {
                        setSelectedUid(nextUid);
                        setActiveTab("fields");
                      }}
                    />
                  </SidebarMenu>
                  <Show
                    when={
                      (contentTypes.data?.length ?? 0) > 0 &&
                      visibleSchemas().length === 0
                    }
                  >
                    <div class="text-muted-foreground px-3 py-2 text-sm">
                      No matching content types
                    </div>
                  </Show>
                  <Show
                    when={
                      !contentTypes.isPending &&
                      (contentTypes.data?.length ?? 0) === 0
                    }
                  >
                    <div class="text-muted-foreground p-3 text-sm">
                      No content types yet
                    </div>
                  </Show>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            <div
              role="separator"
              aria-label="Resize content types sidebar"
              aria-orientation="vertical"
              aria-valuemin={200}
              aria-valuemax={480}
              aria-valuenow={sidebarWidth()}
              tabIndex={0}
              class="hover:bg-primary/30 absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize touch-none"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  const delta = event.key === "ArrowRight" ? 16 : -16;
                  setSidebarWidth((width) =>
                    Math.min(480, Math.max(200, width + delta)),
                  );
                }
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startWidth = sidebarWidth();
                const move = (moveEvent: PointerEvent) => {
                  setSidebarWidth(
                    Math.min(
                      480,
                      Math.max(200, startWidth + moveEvent.clientX - startX),
                    ),
                  );
                };
                const end = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", end);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", end);
              }}
            />
          </Sidebar>

          <SidebarInset class="h-full overflow-y-auto">
            <Show
              when={selectedSchema()}
              fallback={
                <>
                  <Header
                    title="Content Types"
                    description="Define structured content and expose it through TrailBase record APIs."
                    right={
                      <div class="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          disabled={transferBusy()}
                          onClick={() => importFileInput.click()}
                        >
                          <TbOutlineUpload /> Import types
                        </Button>
                        <Button
                          variant="outline"
                          disabled={transferBusy()}
                          onClick={() => {
                            setExportUids(undefined);
                            setExportFormat("json");
                            setModal({ kind: "export" });
                          }}
                        >
                          <TbOutlineDownload /> Export types
                        </Button>
                        <Button onClick={openCreateModal}>
                          <TbOutlinePlus /> Create collection type
                        </Button>
                      </div>
                    }
                  />
                  <div class="flex flex-col gap-4 p-4">
                    <Show when={pageError()}>
                      <div
                        role="alert"
                        class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
                      >
                        {pageError()}
                      </div>
                    </Show>
                    <Show when={contentTypes.isError}>
                      <div
                        role="alert"
                        class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
                      >
                        Could not load content types:{" "}
                        {String(contentTypes.error)}
                      </div>
                    </Show>
                    <Show
                      when={
                        !contentTypes.isPending &&
                        !contentTypes.isError &&
                        (contentTypes.data?.length ?? 0) === 0
                      }
                    >
                      <Card>
                        <CardContent class="flex flex-col items-center gap-2 py-12 text-center">
                          <TbOutlineDatabase class="text-muted-foreground size-8" />
                          <CardTitle>No content types yet</CardTitle>
                          <p class="text-muted-foreground m-0 text-sm">
                            Create a collection type to get started.
                          </p>
                        </CardContent>
                      </Card>
                    </Show>
                    <Show
                      when={
                        !contentTypes.isPending &&
                        (contentTypes.data?.length ?? 0) > 0
                      }
                    >
                      <div class="text-muted-foreground rounded-md border border-dashed p-10 text-center text-sm">
                        Select a content type from the sidebar to edit its
                        fields, views, and settings.
                      </div>
                    </Show>
                  </div>
                </>
              }
            >
              {(schema) => (
                <>
                  <Header
                    title={schema().info.displayName}
                    description={`${schema().kind === "singleType" ? "Single type" : "Collection type"} · /api/${schema().info.pluralName}`}
                    right={
                      <div class="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          disabled={transferBusy()}
                          onClick={() => importFileInput.click()}
                        >
                          <TbOutlineUpload /> Import types
                        </Button>
                        <Button
                          variant="outline"
                          disabled={transferBusy()}
                          onClick={() => {
                            setExportUids(undefined);
                            setExportFormat("json");
                            setModal({ kind: "export" });
                          }}
                        >
                          <TbOutlineDownload /> Export types
                        </Button>
                        <Show when={activeTab() === "fields"}>
                          <Button onClick={() => openFieldModal()}>
                            <TbOutlinePlus /> Add field
                          </Button>
                        </Show>
                      </div>
                    }
                  />
                  <Show when={pageError()}>
                    <div
                      role="alert"
                      class="border-destructive/40 bg-destructive/10 text-destructive mx-4 mt-4 rounded-md border p-3 text-sm"
                    >
                      {pageError()}
                    </div>
                  </Show>
                  <Tabs
                    value={activeTab()}
                    onChange={(value) =>
                      setActiveTab(value as "fields" | "views" | "settings")
                    }
                    class="flex min-h-0 flex-1 flex-col"
                  >
                    <TabsList class="mx-4 my-2 grid w-fit grid-cols-3">
                      <TabsTrigger value="fields">
                        Fields &amp; Relations
                      </TabsTrigger>
                      <TabsTrigger value="views">Views</TabsTrigger>
                      <TabsTrigger value="settings">Settings</TabsTrigger>
                    </TabsList>
                    <TabsContent
                      value="fields"
                      class="flex flex-col gap-4 p-4 pt-0"
                    >
                      <Card>
                        <CardContent class="divide-y p-0">
                          <Show
                            when={Object.keys(schema().attributes).length > 0}
                            fallback={
                              <div class="text-muted-foreground p-10 text-center text-sm">
                                No fields yet. Add a field to start defining
                                this type.
                              </div>
                            }
                          >
                            <For each={Object.entries(schema().attributes)}>
                              {([name, attribute]) => (
                                <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:px-5">
                                  <FieldTypeBadge type={attribute.type} />
                                  <div class="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
                                    <div class="font-medium">
                                      {name}
                                      <Show when={attribute.required}>
                                        <span class="text-destructive ml-0.5">
                                          *
                                        </span>
                                      </Show>
                                    </div>
                                    <div class="text-muted-foreground text-sm">
                                      {fieldTypeLabel(attribute.type)}
                                      <Show when={attribute.computed}>
                                        <span> · Generated</span>
                                      </Show>
                                      <Show when={attribute.unique}>
                                        <span> · Unique</span>
                                      </Show>
                                    </div>
                                  </div>
                                  <div class="flex items-center gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      aria-label={`Edit ${name}`}
                                      disabled={busy()}
                                      onClick={() => openFieldModal(name)}
                                    >
                                      <TbOutlineEdit />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      aria-label={`Delete ${name}`}
                                      disabled={busy()}
                                      onClick={() => removeField(name)}
                                    >
                                      <TbOutlineTrash />
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </For>
                          </Show>
                        </CardContent>
                      </Card>
                    </TabsContent>
                    <TabsContent
                      value="views"
                      class="min-h-0 flex-1 overflow-y-auto p-4 pt-0"
                    >
                      <ContentTypeRecords schema={schema()} />
                    </TabsContent>
                    <TabsContent
                      value="settings"
                      class="flex flex-col gap-4 p-4 pt-0"
                    >
                      <Card>
                        <CardContent class="flex flex-col gap-4 p-5">
                          <div>
                            <h3 class="m-0 text-base font-semibold">General</h3>
                            <p class="text-muted-foreground mt-1 text-sm">
                              Content type identity and API details.
                            </p>
                          </div>
                          <dl class="grid gap-4 text-sm sm:grid-cols-2">
                            <div>
                              <dt class="text-muted-foreground">
                                Display name
                              </dt>
                              <dd class="mt-1 font-medium">
                                {schema().info.displayName}
                              </dd>
                            </div>
                            <div>
                              <dt class="text-muted-foreground">UID</dt>
                              <dd class="mt-1 font-mono">{schema().uid}</dd>
                            </div>
                            <div>
                              <dt class="text-muted-foreground">Type</dt>
                              <dd class="mt-1">
                                {schema().kind === "singleType"
                                  ? "Single type"
                                  : "Collection type"}
                              </dd>
                            </div>
                            <div>
                              <dt class="text-muted-foreground">
                                API endpoint
                              </dt>
                              <dd class="mt-1 font-mono">
                                /api/{schema().info.pluralName}
                              </dd>
                            </div>
                            <div>
                              <dt class="text-muted-foreground">
                                Database table
                              </dt>
                              <dd class="mt-1 font-mono">
                                {schema().tableName}
                              </dd>
                            </div>
                            <div>
                              <dt class="text-muted-foreground">Fields</dt>
                              <dd class="mt-1">
                                {Object.keys(schema().attributes).length}
                              </dd>
                            </div>
                          </dl>
                          <div class="flex flex-wrap justify-between gap-2 border-t pt-4">
                            <Button
                              variant="outline"
                              onClick={() => openEditModal(schema())}
                            >
                              <TbOutlineEdit /> Edit content type
                            </Button>
                            <Button
                              variant="destructive"
                              onClick={() => void remove(schema())}
                            >
                              <TbOutlineTrash /> Delete content type
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </TabsContent>
                  </Tabs>
                </>
              )}
            </Show>
          </SidebarInset>
        </SidebarProvider>
      </div>

      <DialogContent class="max-h-[90vh] max-w-4xl overflow-y-auto">
        <Show when={isMetadataModal()}>
          <DialogHeader>
            <DialogTitle>
              {isEditingMetadata()
                ? "Edit content type"
                : "Create a collection type"}
            </DialogTitle>
            <DialogDescription>
              Set the names used in the admin UI, API, and database.
            </DialogDescription>
          </DialogHeader>
          <div class="flex flex-col gap-4">
            <Show when={error()}>
              <div
                role="alert"
                class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
              >
                {error()}
              </div>
            </Show>
            <div class="grid gap-4 sm:grid-cols-2">
              <label class="flex flex-col gap-1.5 text-sm font-medium">
                Display name
                <input
                  class={inputStyle}
                  value={displayName()}
                  onInput={(e) => {
                    const name = e.currentTarget.value;
                    setDisplayName(name);
                    updateGeneratedNames(name);
                  }}
                  autofocus
                />
              </label>
              <label class="flex flex-col gap-1.5 text-sm font-medium">
                UID
                <input
                  class={inputStyle}
                  value={uid()}
                  onInput={(e) => {
                    setUidEdited(true);
                    setUid(
                      e.currentTarget.value
                        .toLowerCase()
                        .replace(/[^a-z0-9._:]/g, ""),
                    );
                  }}
                  placeholder="article"
                />
                <span class="text-muted-foreground text-xs font-normal">
                  Used to generate the API route and database table.
                </span>
              </label>
              <label class="flex flex-col gap-1.5 text-sm font-medium">
                Singular API name
                <input
                  class={inputStyle}
                  value={singularName()}
                  onInput={(e) => {
                    setSingularEdited(true);
                    setSingularName(slugify(e.currentTarget.value));
                  }}
                />
              </label>
              <label class="flex flex-col gap-1.5 text-sm font-medium">
                Plural API name
                <input
                  class={inputStyle}
                  value={pluralName()}
                  onInput={(e) => {
                    setPluralEdited(true);
                    setPluralName(slugify(e.currentTarget.value));
                  }}
                />
              </label>
            </div>
            <DialogFooter class="gap-2">
              <Button variant="outline" onClick={closeModal}>
                Cancel
              </Button>
              <Button disabled={busy()} onClick={saveMetadata}>
                {busy()
                  ? isEditingMetadata()
                    ? "Saving…"
                    : "Creating…"
                  : isEditingMetadata()
                    ? "Save changes"
                    : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        </Show>

        <Show when={isImportModal()}>
          <DialogHeader>
            <DialogTitle>Import content types</DialogTitle>
            <DialogDescription>
              Review {importDefinitions().length} content types from{" "}
              {importFileName()} before adding them.
            </DialogDescription>
          </DialogHeader>
          <Show when={definitionMappingRequired()}>
            <div class="flex flex-col gap-3">
              <p class="text-sm">
                Map fields from this JSON or YAML file into content type
                definitions.
              </p>
              <MappingEditor
                source={definitionImportRoot()}
                targetFields={["uid", "kind", "info", "attributes"]}
                targetLabel="Content type fields"
                expression={definitionMapping()}
                onExpressionChange={updateDefinitionMapping}
              />
              <p class="text-muted-foreground m-0 text-xs">
                Each mapped definition needs info.singularName and attributes.
                Missing UID, kind, plural name, and display name are generated.
                The mapped preview appears below.
              </p>
              <Show when={definitionMappingError()}>
                <div
                  role="alert"
                  class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
                >
                  {definitionMappingError()}
                </div>
              </Show>
            </div>
          </Show>
          <div class="max-h-64 overflow-y-auto rounded-md border">
            <For each={importDefinitions()}>
              {(definition) => (
                <div class="flex items-center justify-between gap-3 border-b p-3 last:border-b-0">
                  <div class="font-medium">{definition.info.displayName}</div>
                  <div class="text-muted-foreground font-mono text-xs">
                    {definition.uid} ·{" "}
                    {Object.keys(definition.attributes).length} fields
                  </div>
                </div>
              )}
            </For>
          </div>
          <Show when={error()}>
            <div
              role="alert"
              class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
            >
              {error()}
            </div>
          </Show>
          <DialogFooter class="gap-2">
            <Button
              variant="outline"
              disabled={transferBusy()}
              onClick={closeModal}
            >
              Cancel
            </Button>
            <Button
              disabled={
                transferBusy() ||
                importDefinitions().length === 0 ||
                Boolean(definitionMappingError())
              }
              onClick={runImport}
            >
              {transferBusy() ? "Importing…" : "Import content types"}
            </Button>
          </DialogFooter>
        </Show>

        <Show when={isExportModal()}>
          <DialogHeader>
            <DialogTitle>Export content types</DialogTitle>
            <DialogDescription>
              Choose a file format for the content type definitions.
            </DialogDescription>
          </DialogHeader>
          <label class="flex flex-col gap-1.5 text-sm font-medium">
            File type
            <select
              class={inputStyle}
              value={exportFormat()}
              onChange={(event) =>
                setExportFormat(event.currentTarget.value as "json" | "yaml")
              }
            >
              <option value="json">JSON</option>
              <option value="yaml">YAML</option>
            </select>
          </label>
          <DialogFooter class="gap-2">
            <Button variant="outline" onClick={closeModal}>
              Cancel
            </Button>
            <Button onClick={exportDefinitions}>Export</Button>
          </DialogFooter>
        </Show>

        <Show when={isFieldModal()}>
          <Show
            when={fieldStep() === "select"}
            fallback={
              <>
                <DialogHeader>
                  <DialogTitle>
                    {fieldModalName() ? "Edit field" : "Configure field"}
                  </DialogTitle>
                  <DialogDescription>
                    Set the field name and options for{" "}
                    {fieldTypeLabel(fieldDraft().type)}.
                  </DialogDescription>
                </DialogHeader>
                <div class="flex flex-col gap-4">
                  <Show when={error()}>
                    <div
                      role="alert"
                      class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
                    >
                      {error()}
                    </div>
                  </Show>
                  <label class="flex flex-col gap-1.5 text-sm font-medium">
                    Field name
                    <input
                      class={inputStyle}
                      value={fieldDraft().name}
                      onInput={(e) =>
                        setFieldDraft({
                          ...fieldDraft(),
                          name: e.currentTarget.value,
                        })
                      }
                      autofocus
                    />
                  </label>
                  <Show when={supportsGenerated(fieldDraft().type)}>
                    <div class="border-input flex flex-col gap-3 rounded-md border p-4">
                      <label class="flex items-center gap-2 text-sm font-medium">
                        <input
                          type="checkbox"
                          checked={fieldDraft().computed}
                          onChange={(e) =>
                            setFieldDraft({
                              ...fieldDraft(),
                              computed: e.currentTarget.checked,
                              required: e.currentTarget.checked
                                ? false
                                : fieldDraft().required,
                              unique: e.currentTarget.checked
                                ? false
                                : fieldDraft().unique,
                            })
                          }
                        />
                        Generated column
                      </label>
                      <Show when={fieldDraft().computed}>
                        <Show
                          when={!fieldDraft().rollup}
                          fallback={
                            <div class="bg-muted/30 text-muted-foreground rounded-md p-3 text-sm sm:col-span-2">
                              Stored SUM of {fieldDraft().rollup?.relation}.
                              {fieldDraft().rollup?.field}; maintained by the
                              relation runtime.
                            </div>
                          }
                        >
                          <label class="flex flex-col gap-1.5 text-sm font-medium">
                            Expression
                            <textarea
                              class={`${inputStyle} h-24 py-2 font-mono`}
                              value={fieldDraft().expression}
                              placeholder="quantity * unit_price"
                              onInput={(e) =>
                                setFieldDraft({
                                  ...fieldDraft(),
                                  expression: e.currentTarget.value,
                                })
                              }
                            />
                            <span class="text-muted-foreground text-xs font-normal">
                              Use field names, arithmetic, text concatenation,
                              and COALESCE, ROUND, ABS, LOWER, UPPER, or LENGTH.
                            </span>
                          </label>
                        </Show>
                        <label class="flex flex-col gap-1.5 text-sm font-medium">
                          Storage mode
                          <select
                            class={inputStyle}
                            value={fieldDraft().stored ? "stored" : "virtual"}
                            onChange={(e) =>
                              setFieldDraft({
                                ...fieldDraft(),
                                stored: e.currentTarget.value === "stored",
                              })
                            }
                          >
                            <option value="stored">Stored</option>
                            <option value="virtual">Virtual</option>
                          </select>
                        </label>
                      </Show>
                    </div>
                  </Show>
                  <Show
                    when={[
                      "integer",
                      "biginteger",
                      "decimal",
                      "float",
                    ].includes(fieldDraft().type)}
                  >
                    <label class="flex flex-col gap-1.5 text-sm font-medium">
                      Number format
                      <select
                        class={inputStyle}
                        value={fieldDraft().type}
                        onChange={(e) =>
                          setFieldDraft({
                            ...fieldDraft(),
                            type: e.currentTarget.value,
                          })
                        }
                      >
                        <option value="integer">Integer</option>
                        <option value="biginteger">Big integer</option>
                        <option value="decimal">Decimal</option>
                        <option value="float">Float</option>
                      </select>
                    </label>
                  </Show>
                  <Show
                    when={
                      fieldDraft().type === "string" ||
                      fieldDraft().type === "text"
                    }
                  >
                    <label class="flex flex-col gap-1.5 text-sm font-medium">
                      Text format
                      <select
                        class={inputStyle}
                        value={fieldDraft().type}
                        onChange={(e) =>
                          setFieldDraft({
                            ...fieldDraft(),
                            type: e.currentTarget.value,
                          })
                        }
                      >
                        <option value="string">Short text</option>
                        <option value="text">Long text</option>
                      </select>
                    </label>
                  </Show>
                  <Show
                    when={["date", "datetime", "time"].includes(
                      fieldDraft().type,
                    )}
                  >
                    <label class="flex flex-col gap-1.5 text-sm font-medium">
                      Date format
                      <select
                        class={inputStyle}
                        value={fieldDraft().type}
                        onChange={(e) =>
                          setFieldDraft({
                            ...fieldDraft(),
                            type: e.currentTarget.value,
                          })
                        }
                      >
                        <option value="date">Date</option>
                        <option value="datetime">Date and time</option>
                        <option value="time">Time</option>
                      </select>
                    </label>
                  </Show>
                  <Show when={fieldDraft().type === "enumeration"}>
                    <label class="flex flex-col gap-1.5 text-sm font-medium">
                      Values
                      <textarea
                        class={`${inputStyle} h-28 py-2`}
                        value={fieldDraft().enumValues}
                        placeholder={"draft\npublished\narchived"}
                        onInput={(e) =>
                          setFieldDraft({
                            ...fieldDraft(),
                            enumValues: e.currentTarget.value,
                          })
                        }
                      />
                      <span class="text-muted-foreground text-xs font-normal">
                        Enter one allowed value per line.
                      </span>
                    </label>
                  </Show>
                  <Show when={fieldDraft().type === "relation"}>
                    <div class="flex flex-col gap-4">
                      <div class="grid gap-4 sm:grid-cols-2">
                        <label class="flex flex-col gap-1.5 text-sm font-medium">
                          Related collection
                          <select
                            class={inputStyle}
                            value={fieldDraft().relationTarget}
                            onChange={(e) =>
                              setFieldDraft({
                                ...fieldDraft(),
                                relationTarget: e.currentTarget.value,
                              })
                            }
                          >
                            <option value="">Select a collection type</option>
                            <For
                              each={
                                contentTypes.data?.filter(
                                  (item) => item.kind === "collectionType",
                                ) ?? []
                              }
                            >
                              {(item) => (
                                <option value={item.uid}>
                                  {item.info.displayName}
                                </option>
                              )}
                            </For>
                          </select>
                        </label>
                        <label class="flex flex-col gap-1.5 text-sm font-medium">
                          Relation type
                          <select
                            class={inputStyle}
                            value={fieldDraft().relationCardinality}
                            onChange={(e) =>
                              setFieldDraft({
                                ...fieldDraft(),
                                relationCardinality: e.currentTarget.value as
                                  "manyToOne" | "manyToMany",
                              })
                            }
                          >
                            <option value="manyToOne">Many to one</option>
                            <option value="manyToMany">
                              Many to many (with attributes)
                            </option>
                          </select>
                        </label>
                      </div>
                      <Show
                        when={fieldDraft().relationCardinality === "manyToMany"}
                      >
                        <section class="border-input flex flex-col gap-3 rounded-md border p-4">
                          <div class="flex items-center justify-between gap-3">
                            <div>
                              <h3 class="text-sm font-medium">
                                Relation attributes
                              </h3>
                              <p class="text-muted-foreground text-xs">
                                Add fields stored on each link between records.
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={addRelationAttribute}
                            >
                              Add attribute
                            </Button>
                          </div>
                          <Show
                            when={
                              Object.keys(fieldDraft().relationAttributes)
                                .length > 0
                            }
                            fallback={
                              <p class="text-muted-foreground text-sm">
                                This is a simple many-to-many relation. Add
                                fields such as quantity or unit price to store
                                values on each link.
                              </p>
                            }
                          >
                            <For
                              each={Object.entries(
                                fieldDraft().relationAttributes,
                              )}
                            >
                              {([attributeName, attribute]) => (
                                <div class="bg-muted/30 flex flex-col gap-3 rounded-md border p-3">
                                  <div class="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                                    <label class="flex flex-col gap-1.5 text-xs font-medium">
                                      Field name
                                      <input
                                        class={inputStyle}
                                        value={attributeName}
                                        onInput={(e) =>
                                          updateRelationAttribute(
                                            attributeName,
                                            {},
                                            e.currentTarget.value,
                                          )
                                        }
                                      />
                                    </label>
                                    <label class="flex flex-col gap-1.5 text-xs font-medium">
                                      Type
                                      <select
                                        class={inputStyle}
                                        value={attribute.type}
                                        onChange={(e) =>
                                          updateRelationAttribute(
                                            attributeName,
                                            { type: e.currentTarget.value },
                                          )
                                        }
                                      >
                                        <For each={fieldTypeOptions}>
                                          {(option) => (
                                            <option value={option.type}>
                                              {option.label}
                                            </option>
                                          )}
                                        </For>
                                      </select>
                                    </label>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      aria-label={`Remove ${attributeName}`}
                                      onClick={() => {
                                        const attributes = {
                                          ...fieldDraft().relationAttributes,
                                        };
                                        delete attributes[attributeName];
                                        setFieldDraft({
                                          ...fieldDraft(),
                                          relationAttributes: attributes,
                                        });
                                      }}
                                    >
                                      Remove
                                    </Button>
                                  </div>
                                  <Show
                                    when={supportsGenerated(attribute.type)}
                                  >
                                    <div class="flex flex-col gap-2">
                                      <label class="flex items-center gap-2 text-xs">
                                        <input
                                          type="checkbox"
                                          checked={attribute.computed ?? false}
                                          onChange={(e) =>
                                            updateRelationAttribute(
                                              attributeName,
                                              {
                                                computed:
                                                  e.currentTarget.checked,
                                                ...(e.currentTarget.checked
                                                  ? { required: false }
                                                  : {}),
                                              },
                                            )
                                          }
                                        />
                                        Generated column
                                      </label>
                                      <Show when={attribute.computed}>
                                        <div class="grid gap-3 sm:grid-cols-2">
                                          <label class="flex flex-col gap-1.5 text-xs font-medium sm:col-span-2">
                                            Expression
                                            <textarea
                                              class={`${inputStyle} h-20 py-2 font-mono`}
                                              value={attribute.expression ?? ""}
                                              placeholder="quantity * unit_price"
                                              onInput={(e) =>
                                                updateRelationAttribute(
                                                  attributeName,
                                                  {
                                                    expression:
                                                      e.currentTarget.value,
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label class="flex flex-col gap-1.5 text-xs font-medium">
                                            Storage mode
                                            <select
                                              class={inputStyle}
                                              value={
                                                attribute.stored === false
                                                  ? "virtual"
                                                  : "stored"
                                              }
                                              onChange={(e) =>
                                                updateRelationAttribute(
                                                  attributeName,
                                                  {
                                                    stored:
                                                      e.currentTarget.value ===
                                                      "stored",
                                                  },
                                                )
                                              }
                                            >
                                              <option value="stored">
                                                Stored
                                              </option>
                                              <option value="virtual">
                                                Virtual
                                              </option>
                                            </select>
                                          </label>
                                        </div>
                                      </Show>
                                    </div>
                                  </Show>
                                  <label class="flex items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={attribute.required ?? false}
                                      disabled={attribute.computed ?? false}
                                      onChange={(e) =>
                                        updateRelationAttribute(attributeName, {
                                          required: e.currentTarget.checked,
                                        })
                                      }
                                    />
                                    Required
                                  </label>
                                  <Show when={!attribute.computed}>
                                    <label class="flex flex-col gap-1.5 text-xs font-medium">
                                      Default kind
                                      <select
                                        class={inputStyle}
                                        value={
                                          sqlViewDefaultSql(
                                            attribute.default,
                                          ) === undefined
                                            ? "value"
                                            : "sqlView"
                                        }
                                        onChange={(e) =>
                                          updateRelationAttribute(
                                            attributeName,
                                            {
                                              default:
                                                e.currentTarget.value ===
                                                "sqlView"
                                                  ? {
                                                      type: "sqlView",
                                                      sql: "",
                                                    }
                                                  : undefined,
                                            },
                                          )
                                        }
                                      >
                                        <option value="value">
                                          Literal value
                                        </option>
                                        <option value="sqlView">
                                          SQL view
                                        </option>
                                      </select>
                                    </label>
                                    <Show
                                      when={
                                        sqlViewDefaultSql(attribute.default) !==
                                        undefined
                                      }
                                    >
                                      <label class="flex flex-col gap-1.5 text-xs font-medium">
                                        SQL view query
                                        <textarea
                                          class={`${inputStyle} h-20 py-2 font-mono`}
                                          value={
                                            sqlViewDefaultSql(
                                              attribute.default,
                                            ) ?? ""
                                          }
                                          placeholder="SELECT ... AS value"
                                          onInput={(e) =>
                                            updateRelationAttribute(
                                              attributeName,
                                              {
                                                default: {
                                                  type: "sqlView",
                                                  sql: e.currentTarget.value,
                                                },
                                              },
                                            )
                                          }
                                        />
                                        <span class="text-muted-foreground text-xs font-normal">
                                          Use a SELECT or WITH query. For
                                          relation attributes, NEW.source_id and
                                          NEW.target_id reference linked
                                          records.
                                        </span>
                                      </label>
                                    </Show>
                                    <Show
                                      when={
                                        sqlViewDefaultSql(attribute.default) ===
                                        undefined
                                      }
                                    >
                                      <label class="flex flex-col gap-1.5 text-xs font-medium">
                                        Default value
                                        <Show
                                          when={attribute.type === "boolean"}
                                          fallback={
                                            <input
                                              class={inputStyle}
                                              type={
                                                [
                                                  "integer",
                                                  "biginteger",
                                                  "decimal",
                                                  "float",
                                                ].includes(attribute.type)
                                                  ? "number"
                                                  : "text"
                                              }
                                              step={
                                                ["decimal", "float"].includes(
                                                  attribute.type,
                                                )
                                                  ? "any"
                                                  : undefined
                                              }
                                              value={
                                                attribute.default === undefined
                                                  ? ""
                                                  : typeof attribute.default ===
                                                      "string"
                                                    ? attribute.default
                                                    : JSON.stringify(
                                                        attribute.default,
                                                      )
                                              }
                                              placeholder="No default"
                                              onInput={(e) => {
                                                const value =
                                                  e.currentTarget.value;
                                                try {
                                                  updateRelationAttribute(
                                                    attributeName,
                                                    {
                                                      default:
                                                        value.trim() === ""
                                                          ? undefined
                                                          : parseDefaultValue(
                                                              attribute.type,
                                                              value,
                                                            ),
                                                    },
                                                  );
                                                  setError(undefined);
                                                } catch {
                                                  setError(
                                                    "Enter a valid JSON default value.",
                                                  );
                                                }
                                              }}
                                            />
                                          }
                                        >
                                          <select
                                            class={inputStyle}
                                            value={
                                              attribute.default === true
                                                ? "true"
                                                : attribute.default === false
                                                  ? "false"
                                                  : ""
                                            }
                                            onChange={(e) =>
                                              updateRelationAttribute(
                                                attributeName,
                                                {
                                                  default:
                                                    e.currentTarget.value === ""
                                                      ? undefined
                                                      : e.currentTarget
                                                          .value === "true",
                                                },
                                              )
                                            }
                                          >
                                            <option value="">No default</option>
                                            <option value="true">True</option>
                                            <option value="false">False</option>
                                          </select>
                                        </Show>
                                      </label>
                                    </Show>
                                  </Show>
                                </div>
                              )}
                            </For>
                          </Show>
                        </section>
                      </Show>
                    </div>
                  </Show>
                  <Show when={!fieldDraft().computed}>
                    <div class="grid gap-4 sm:grid-cols-2">
                      <label class="flex flex-col gap-1.5 text-sm font-medium">
                        Default kind
                        <select
                          class={inputStyle}
                          value={fieldDraft().defaultMode}
                          onChange={(e) =>
                            setFieldDraft({
                              ...fieldDraft(),
                              defaultMode: e.currentTarget.value as
                                "value" | "sqlView",
                              defaultValue: "",
                              defaultSql: "",
                            })
                          }
                        >
                          <option value="value">Literal value</option>
                          <option value="sqlView">SQL view</option>
                        </select>
                      </label>
                      <Show when={fieldDraft().defaultMode === "sqlView"}>
                        <label class="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                          SQL view query
                          <textarea
                            class={`${inputStyle} h-28 py-2 font-mono`}
                            value={fieldDraft().defaultSql}
                            placeholder="SELECT ... AS value"
                            onInput={(e) =>
                              setFieldDraft({
                                ...fieldDraft(),
                                defaultSql: e.currentTarget.value,
                              })
                            }
                          />
                          <span class="text-muted-foreground text-xs font-normal">
                            Use a single SELECT or WITH query. In relation
                            attributes, NEW.source_id and NEW.target_id refer to
                            the linked records.
                          </span>
                        </label>
                      </Show>
                      <Show
                        when={
                          fieldDraft().defaultMode === "value" &&
                          fieldDraft().type === "boolean"
                        }
                      >
                        <label class="flex flex-col gap-1.5 text-sm font-medium">
                          Default value
                          <select
                            class={inputStyle}
                            value={fieldDraft().defaultValue}
                            onChange={(e) =>
                              setFieldDraft({
                                ...fieldDraft(),
                                defaultValue: e.currentTarget.value,
                              })
                            }
                          >
                            <option value="">No default</option>
                            <option value="true">True</option>
                            <option value="false">False</option>
                          </select>
                        </label>
                      </Show>
                      <Show
                        when={
                          fieldDraft().defaultMode === "value" &&
                          fieldDraft().type !== "boolean"
                        }
                      >
                        <label class="flex flex-col gap-1.5 text-sm font-medium">
                          Default value
                          <input
                            class={inputStyle}
                            value={fieldDraft().defaultValue}
                            placeholder={
                              ["json", "media"].includes(fieldDraft().type)
                                ? "{}"
                                : "Optional"
                            }
                            onInput={(e) =>
                              setFieldDraft({
                                ...fieldDraft(),
                                defaultValue: e.currentTarget.value,
                              })
                            }
                          />
                        </label>
                      </Show>
                      <Show
                        when={[
                          "integer",
                          "biginteger",
                          "decimal",
                          "float",
                        ].includes(fieldDraft().type)}
                      >
                        <>
                          <label class="flex flex-col gap-1.5 text-sm font-medium">
                            Minimum value
                            <input
                              class={inputStyle}
                              type="number"
                              value={fieldDraft().min}
                              onInput={(e) =>
                                setFieldDraft({
                                  ...fieldDraft(),
                                  min: e.currentTarget.value,
                                })
                              }
                            />
                          </label>
                          <label class="flex flex-col gap-1.5 text-sm font-medium">
                            Maximum value
                            <input
                              class={inputStyle}
                              type="number"
                              value={fieldDraft().max}
                              onInput={(e) =>
                                setFieldDraft({
                                  ...fieldDraft(),
                                  max: e.currentTarget.value,
                                })
                              }
                            />
                          </label>
                        </>
                      </Show>
                      <Show
                        when={[
                          "string",
                          "text",
                          "richtext",
                          "richtext_markdown",
                          "email",
                          "password",
                          "uid",
                        ].includes(fieldDraft().type)}
                      >
                        <>
                          <label class="flex flex-col gap-1.5 text-sm font-medium">
                            Minimum length
                            <input
                              class={inputStyle}
                              type="number"
                              min="0"
                              value={fieldDraft().minLength}
                              onInput={(e) =>
                                setFieldDraft({
                                  ...fieldDraft(),
                                  minLength: e.currentTarget.value,
                                })
                              }
                            />
                          </label>
                          <label class="flex flex-col gap-1.5 text-sm font-medium">
                            Maximum length
                            <input
                              class={inputStyle}
                              type="number"
                              min="0"
                              value={fieldDraft().maxLength}
                              onInput={(e) =>
                                setFieldDraft({
                                  ...fieldDraft(),
                                  maxLength: e.currentTarget.value,
                                })
                              }
                            />
                          </label>
                          <label class="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                            Validation pattern
                            <input
                              class={inputStyle}
                              value={fieldDraft().regex}
                              placeholder="^[a-z0-9-]+$"
                              onInput={(e) =>
                                setFieldDraft({
                                  ...fieldDraft(),
                                  regex: e.currentTarget.value,
                                })
                              }
                            />
                          </label>
                        </>
                      </Show>
                      <Show when={fieldDraft().type === "uid"}>
                        <label class="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                          Generate from field
                          <select
                            class={inputStyle}
                            value={fieldDraft().targetField}
                            onChange={(e) =>
                              setFieldDraft({
                                ...fieldDraft(),
                                targetField: e.currentTarget.value,
                              })
                            }
                          >
                            <option value="">No source field</option>
                            <For
                              each={Object.keys(
                                selectedSchema()?.attributes ?? {},
                              ).filter((name) => name !== fieldModalName())}
                            >
                              {(name) => <option value={name}>{name}</option>}
                            </For>
                          </select>
                        </label>
                      </Show>
                      <Show when={fieldDraft().type === "media"}>
                        <div class="flex flex-col gap-3 sm:col-span-2">
                          <label class="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={fieldDraft().multiple}
                              onChange={(e) =>
                                setFieldDraft({
                                  ...fieldDraft(),
                                  multiple: e.currentTarget.checked,
                                })
                              }
                            />
                            Allow multiple files
                          </label>
                          <div class="flex flex-wrap gap-4">
                            <For each={["images", "videos", "audios", "files"]}>
                              {(mediaType) => (
                                <label class="flex items-center gap-2 text-sm capitalize">
                                  <input
                                    type="checkbox"
                                    checked={fieldDraft().allowedTypes.includes(
                                      mediaType,
                                    )}
                                    onChange={(e) =>
                                      setFieldDraft({
                                        ...fieldDraft(),
                                        allowedTypes: e.currentTarget.checked
                                          ? [
                                              ...fieldDraft().allowedTypes,
                                              mediaType,
                                            ]
                                          : fieldDraft().allowedTypes.filter(
                                              (type) => type !== mediaType,
                                            ),
                                      })
                                    }
                                  />
                                  {mediaType}
                                </label>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </div>
                    <label class="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={fieldDraft().private}
                        onChange={(e) =>
                          setFieldDraft({
                            ...fieldDraft(),
                            private: e.currentTarget.checked,
                          })
                        }
                      />
                      Private field (exclude from this record API)
                    </label>
                  </Show>
                  <Show when={!fieldDraft().computed}>
                    <div class="flex flex-wrap gap-5">
                      <label class="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={fieldDraft().required}
                          onChange={(e) =>
                            setFieldDraft({
                              ...fieldDraft(),
                              required: e.currentTarget.checked,
                            })
                          }
                        />
                        Required
                      </label>
                      <label class="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={
                            fieldDraft().type === "uid" || fieldDraft().unique
                          }
                          disabled={fieldDraft().type === "uid"}
                          onChange={(e) =>
                            setFieldDraft({
                              ...fieldDraft(),
                              unique: e.currentTarget.checked,
                            })
                          }
                        />
                        Unique
                      </label>
                    </div>
                  </Show>
                  <DialogFooter class="gap-2">
                    <Button variant="outline" onClick={closeModal}>
                      Cancel
                    </Button>
                    <Show when={!fieldModalName()}>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setError(undefined);
                          setFieldStep("select");
                        }}
                      >
                        Back
                      </Button>
                    </Show>
                    <Button disabled={busy()} onClick={saveField}>
                      {busy()
                        ? "Saving…"
                        : fieldModalName()
                          ? "Save changes"
                          : "Add field"}
                    </Button>
                  </DialogFooter>
                </div>
              </>
            }
          >
            <DialogHeader>
              <DialogTitle>Select a field for your collection type</DialogTitle>
              <DialogDescription>
                Choose the kind of value this field will store.
              </DialogDescription>
            </DialogHeader>
            <div class="grid gap-3 sm:grid-cols-2">
              <For each={fieldTypeOptions}>
                {(option) => (
                  <button
                    type="button"
                    class="border-input bg-card hover:bg-accent/40 focus-visible:ring-ring flex min-h-20 items-center gap-4 rounded-md border p-4 text-left transition-colors outline-none focus-visible:ring-2"
                    onClick={() => {
                      setError(undefined);
                      setFieldDraft({
                        ...fieldDraft(),
                        type: option.type,
                        unique: option.type === "uid" || fieldDraft().unique,
                      });
                      setFieldStep("configure");
                    }}
                  >
                    <FieldTypeBadge type={option.type} large />
                    <span class="flex min-w-0 flex-col gap-1">
                      <span class="font-medium">{option.label}</span>
                      <span class="text-muted-foreground text-sm">
                        {option.description}
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeModal}>
                Cancel
              </Button>
            </DialogFooter>
          </Show>
        </Show>
      </DialogContent>
    </Dialog>
  );
}
