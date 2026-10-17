import { For, Show, createSignal } from "solid-js";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  TbOutlineDotsVertical,
  TbOutlineBraces,
  TbOutlineCalendar,
  TbOutlineDatabase,
  TbOutlineDownload,
  TbOutlineEdit,
  TbOutlineFileText,
  TbOutlineLetterA,
  TbOutlinePlus,
  TbOutlineTrash,
  TbOutlineUpload,
} from "solid-icons/tb";
import { stringify as stringifyYaml } from "yaml";

import { Header } from "@/components/Header";
import { showToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
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
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
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
} from "@/lib/content-type-transfer";

function contentTypeBundle(value: unknown): ContentTypeSchema[] | undefined {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === "object" && "contentTypes" in value
      ? (value as { contentTypes: unknown }).contentTypes
      : undefined;
  if (!Array.isArray(candidate) || candidate.length === 0) return undefined;
  for (const item of candidate) {
    if (!item || typeof item !== "object") return undefined;
    const schema = item as Partial<ContentTypeSchema>;
    if (
      !schema.uid ||
      !["collectionType", "singleType"].includes(schema.kind ?? "") ||
      !schema.info?.displayName ||
      !schema.info.singularName ||
      !schema.info.pluralName ||
      !schema.attributes ||
      typeof schema.attributes !== "object"
    ) {
      return undefined;
    }
  }
  return candidate as ContentTypeSchema[];
}

type FieldDraft = {
  name: string;
  type: string;
  required: boolean;
  unique: boolean;
  enumValues: string;
  relationTarget: string;
  computed: boolean;
  expression: string;
  stored: boolean;
  private: boolean;
  defaultValue: string;
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
    mark: "Aa",
  },
  {
    type: "boolean",
    label: "Boolean",
    description: "Yes or no, true or false",
    mark: "●",
  },
  {
    type: "richtext",
    label: "Rich text (Blocks)",
    description: "Structured rich text content",
    mark: "⋮",
  },
  {
    type: "json",
    label: "JSON",
    description: "Structured data in JSON format",
    mark: "{}",
  },
  {
    type: "decimal",
    label: "Number",
    description: "Integer or decimal values",
    mark: "123",
  },
  { type: "email", label: "Email", description: "An email address", mark: "@" },
  { type: "date", label: "Date", description: "A calendar date", mark: "▦" },
  {
    type: "password",
    label: "Password",
    description: "A password value",
    mark: "●",
  },
  {
    type: "media",
    label: "Media",
    description: "JSON file or media references",
    mark: "▧",
  },
  {
    type: "enumeration",
    label: "Enumeration",
    description: "Choose from a fixed list of values",
    mark: "☷",
  },
  {
    type: "relation",
    label: "Relation",
    description: "Reference another collection type",
    mark: "↗",
  },
  {
    type: "uid",
    label: "UID",
    description: "A unique text identifier",
    mark: "⌘",
  },
  {
    type: "richtext_markdown",
    label: "Rich text (Markdown)",
    description: "Markdown formatted text",
    mark: "≡",
  },
];

function ContentTypePickerItems(props: {
  schemas: ContentTypeSchema[];
  selectedUid: string | undefined;
  onSelect: (uid: string) => void;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <For each={props.schemas}>
      {(schema) => (
        <SidebarMenuItem>
          <SidebarMenuButton
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

function FieldTypeBadge(props: { type: string }) {
  const iconClass =
    "flex size-9 shrink-0 items-center justify-center rounded border border-primary/20 bg-primary/5 text-primary";
  return (
    <span class={iconClass} aria-hidden="true">
      <Show when={props.type === "date" || props.type === "datetime"}>
        <TbOutlineCalendar class="size-4" />
      </Show>
      <Show when={props.type === "json"}>
        <TbOutlineBraces class="size-4" />
      </Show>
      <Show when={props.type === "richtext" || props.type === "text"}>
        <TbOutlineFileText class="size-4" />
      </Show>
      <Show
        when={
          props.type !== "date" &&
          props.type !== "datetime" &&
          props.type !== "json" &&
          props.type !== "richtext" &&
          props.type !== "text"
        }
      >
        <Show
          when={props.type === "string" || props.type === "email"}
          fallback="#"
        >
          <TbOutlineLetterA class="size-4" />
        </Show>
      </Show>
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
    computed: false,
    expression: "",
    stored: true,
    private: false,
    defaultValue: "",
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
            computed: attribute.computed ?? false,
            expression: attribute.expression ?? "",
            stored: attribute.stored ?? true,
            private: attribute.private ?? false,
            defaultValue:
              attribute.default === undefined
                ? ""
                : typeof attribute.default === "string"
                  ? attribute.default
                  : JSON.stringify(attribute.default),
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
            computed: false,
            expression: "",
            stored: true,
            private: false,
            defaultValue: "",
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
    if (fieldDraft().computed && !fieldDraft().expression.trim()) {
      setError("Enter an expression for the generated field.");
      return;
    }
    if (
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
    attributes[name] = {
      type: fieldDraft().type,
      required: fieldDraft().computed ? false : fieldDraft().required,
      unique: fieldDraft().computed
        ? false
        : fieldDraft().type === "uid" || fieldDraft().unique,
      private: fieldDraft().private,
      ...(fieldDraft().defaultValue.trim() && !fieldDraft().computed
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
            expression: fieldDraft().expression.trim(),
            stored: fieldDraft().stored,
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
        ? { relationTarget: fieldDraft().relationTarget }
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

  async function loadImportFile(file: File) {
    setError(undefined);
    setPageError(undefined);
    try {
      const root = parseImportDocument(await file.text(), file.name);
      setDefinitionImportRoot(root);
      const bundle = contentTypeBundle(root);
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
          const mappedBundle = contentTypeBundle(mapped);
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
      const bundle = contentTypeBundle(mapped);
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
      for (const item of importDefinitions()) {
        const {
          tableName: _tableName,
          databaseSchema: _databaseSchema,
          ...definition
        } = item;
        await createContentType(definition);
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
    const definitions = (contentTypes.data ?? []).map(
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
        <SidebarProvider class="h-full min-h-0">
          <Sidebar
            class="absolute"
            variant="sidebar"
            side="left"
            collapsible="offcanvas"
          >
            <SidebarHeader class="gap-3 p-3">
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="font-semibold">Content Types</div>
                  <div class="text-muted-foreground text-xs">
                    {contentTypes.data?.length ?? 0} types
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Create content type"
                  onClick={openCreateModal}
                >
                  <TbOutlinePlus />
                </Button>
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
                <SidebarGroupLabel>Collections</SidebarGroupLabel>
                <SidebarGroupContent>
                  <Show when={contentTypes.isPending}>
                    <div class="text-muted-foreground px-3 py-2 text-sm">
                      Loading content types…
                    </div>
                  </Show>
                  <SidebarMenu>
                    <ContentTypePickerItems
                      schemas={(contentTypes.data ?? []).filter((schema) =>
                        `${schema.info.displayName} ${schema.uid}`
                          .toLowerCase()
                          .includes(search().toLowerCase()),
                      )}
                      selectedUid={selectedUid()}
                      onSelect={(nextUid) => {
                        setSelectedUid(nextUid);
                        setActiveTab("fields");
                      }}
                    />
                  </SidebarMenu>
                  <Show
                    when={
                      (contentTypes.data?.length ?? 0) > 0 &&
                      !(contentTypes.data ?? []).some((schema) =>
                        `${schema.info.displayName} ${schema.uid}`
                          .toLowerCase()
                          .includes(search().toLowerCase()),
                      )
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
            <SidebarFooter>
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
              <DropdownMenu placement="top-end">
                <DropdownMenuTrigger
                  class={buttonVariants({ variant: "outline", size: "icon" })}
                  aria-label="Content type actions"
                  disabled={transferBusy()}
                >
                  <TbOutlineDotsVertical />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => importFileInput.click()}>
                    <TbOutlineUpload /> Import types
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setExportFormat("json");
                      setModal({ kind: "export" });
                    }}
                  >
                    <TbOutlineDownload /> Export types
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarFooter>
            <SidebarRail />
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
                This file does not match the content type bundle format. Map its
                fields to content type definitions.
              </p>
              <MappingEditor
                source={definitionImportRoot()}
                targetFields={["uid", "kind", "info", "attributes"]}
                targetLabel="Content type fields"
                expression={definitionMapping()}
                onExpressionChange={updateDefinitionMapping}
              />
              <p class="text-muted-foreground m-0 text-xs">
                The result must contain uid, kind, info, and attributes for each
                content type. The mapped preview appears below.
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
                            Use field names, arithmetic, text concatenation, and
                            COALESCE, ROUND, ABS, LOWER, UPPER, or LENGTH.
                          </span>
                        </label>
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
                  </Show>
                  <Show when={!fieldDraft().computed}>
                    <div class="grid gap-4 sm:grid-cols-2">
                      <Show when={fieldDraft().type === "boolean"}>
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
                      <Show when={fieldDraft().type !== "boolean"}>
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
                    <span class="border-primary/20 bg-primary/5 text-primary flex size-10 shrink-0 items-center justify-center rounded-sm border text-sm font-semibold">
                      {option.mark}
                    </span>
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
