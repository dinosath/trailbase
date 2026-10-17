import { Show, createSignal } from "solid-js";
import { TbOutlineDownload, TbOutlineUpload } from "solid-icons/tb";
import type { Table } from "trailbase-bindings";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MappingEditor } from "@/components/transfer/MappingEditor";
import { showToast } from "@/components/ui/toast";
import type { ContentTypeSchema } from "@/lib/api/content-types";
import {
  applyJqMapping,
  downloadContent,
  exportContentTypeRecords,
  importContentTypeRecords,
  inspectRecordSource,
  parseImportDocument,
  schemaMatchError,
  serializeCsv,
} from "@/lib/content-type-transfer";

const inputStyle =
  "border-input bg-background h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function tableTransferSchema(table: Table): ContentTypeSchema {
  const types: Record<string, string> = {
    Integer: "integer",
    Real: "decimal",
    Numeric: "decimal",
    Text: "string",
    Blob: "json",
  };
  return {
    uid: table.name.name,
    kind: "collectionType",
    info: {
      singularName: table.name.name,
      pluralName: table.name.name,
      displayName: table.name.name,
    },
    tableName: table.name.name,
    databaseSchema: table.name.database_schema ?? "main",
    attributes: Object.fromEntries(
      table.columns.map((column) => [
        column.name,
        {
          type: types[column.affinity_type] ?? "string",
          required:
            column.options.includes("NotNull") &&
            !column.options.some(
              (option) => typeof option === "object" && "Default" in option,
            ),
          computed: column.options.some(
            (option) => typeof option === "object" && "Generated" in option,
          ),
        },
      ]),
    ),
  };
}

export function RecordTransferDialog(props: {
  table: Table;
  onImported: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [mode, setMode] = createSignal<"import" | "export">("import");
  const [format, setFormat] = createSignal<"json" | "csv">("json");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [rows, setRows] = createSignal<Record<string, unknown>[]>([]);
  const [root, setRoot] = createSignal<unknown>();
  const [mapping, setMapping] = createSignal("");
  const [mappingRequired, setMappingRequired] = createSignal(false);
  const [filename, setFilename] = createSignal("");
  const [progress, setProgress] = createSignal(0);
  const [sourceSample, setSourceSample] = createSignal("");
  let fileInput!: HTMLInputElement;
  const schema = () => tableTransferSchema(props.table);

  function close() {
    if (busy()) return;
    setOpen(false);
    setError(undefined);
  }

  async function loadFile(file: File) {
    try {
      const parsed = parseImportDocument(await file.text(), file.name);
      const source = inspectRecordSource(parsed);
      const mismatch = schemaMatchError(schema(), source.records);
      setRoot(parsed);
      setFilename(file.name);
      setSourceSample(JSON.stringify(source.records[0], null, 2));
      setMappingRequired(Boolean(mismatch));
      if (mismatch) {
        setMapping("");
        setRows([]);
        setError("Adjust the mapping to match the selected table.");
      } else {
        setMapping("");
        setRows(source.records);
        setError(undefined);
      }
      setProgress(0);
      setMode("import");
      setOpen(true);
    } catch (err) {
      showToast({
        title: "Could not read import file",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function updateMapping(expression: string) {
    setMapping(expression);
    try {
      const mapped = applyJqMapping(root(), expression);
      setRows(mapped);
      setError(schemaMatchError(schema(), mapped));
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function exportRows() {
    setBusy(true);
    setError(undefined);
    try {
      const records = await exportContentTypeRecords(schema());
      const tableName = props.table.name.name;
      if (format() === "json") {
        downloadContent(
          `${tableName}.json`,
          `${JSON.stringify(records, null, 2)}\n`,
          "application/json;charset=utf-8",
        );
      } else {
        downloadContent(
          `${tableName}.csv`,
          serializeCsv(records, Object.keys(schema().attributes)),
          "text/csv;charset=utf-8",
        );
      }
      setOpen(false);
      showToast({
        title: "Export complete",
        description: `Exported ${records.length} records.`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setProgress(0);
    setError(undefined);
    try {
      await importContentTypeRecords(schema(), rows(), setProgress);
      props.onImported();
      setOpen(false);
      showToast({
        title: "Import complete",
        description: `Imported ${rows().length} records into ${props.table.name.name}.`,
      });
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : String(err)}${progress() ? ` (${progress()} records imported before the error.)` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".json,.jsonl,.ndjson,.yaml,.yml,.xml,.csv,.tsv,application/json,text/csv,application/yaml,text/yaml,application/xml,text/xml"
        class="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void loadFile(file);
        }}
      />
      <Button variant="outline" size="sm" onClick={() => fileInput.click()}>
        <TbOutlineUpload /> Import
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setMode("export");
          setFormat("json");
          setError(undefined);
          setOpen(true);
        }}
      >
        <TbOutlineDownload /> Export
      </Button>
      <Dialog open={open()} modal onOpenChange={(next) => !next && close()}>
        <DialogContent class="max-w-2xl">
          <Show
            when={mode() === "export"}
            fallback={
              <>
                <DialogHeader>
                  <DialogTitle>
                    Import records into {props.table.name.name}
                  </DialogTitle>
                  <DialogDescription>
                    {rows().length} rows from {filename()}. The selected table
                    defines the expected columns.
                  </DialogDescription>
                </DialogHeader>
                <Show when={mappingRequired()}>
                  <div class="flex flex-col gap-3">
                    <p class="text-sm">
                      The file shape differs from this table. Map the data to
                      the selected table fields.
                    </p>
                    <MappingEditor
                      source={root()}
                      targetFields={Object.keys(schema().attributes).filter(
                        (name) => !schema().attributes[name].computed,
                      )}
                      targetLabel="Table columns"
                      expression={mapping()}
                      onExpressionChange={updateMapping}
                    />
                    <details class="text-sm">
                      <summary class="cursor-pointer font-medium">
                        Input record
                      </summary>
                      <pre class="bg-muted mt-2 max-h-32 overflow-auto rounded-md p-3 text-xs">
                        {sourceSample()}
                      </pre>
                    </details>
                    <Show when={!error() && rows().length}>
                      <pre class="bg-muted max-h-32 overflow-auto rounded-md p-3 text-xs">
                        {JSON.stringify(rows()[0], null, 2)}
                      </pre>
                    </Show>
                  </div>
                </Show>
                <Show when={!mappingRequired() && rows().length}>
                  <p class="text-muted-foreground text-sm">
                    File columns match the selected table.
                  </p>
                </Show>
              </>
            }
          >
            <DialogHeader>
              <DialogTitle>Export {props.table.name.name}</DialogTitle>
              <DialogDescription>
                Choose a file format for the table records.
              </DialogDescription>
            </DialogHeader>
            <label class="flex flex-col gap-1.5 text-sm font-medium">
              File type
              <select
                class={inputStyle}
                value={format()}
                onChange={(event) =>
                  setFormat(event.currentTarget.value as "json" | "csv")
                }
              >
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </label>
          </Show>
          <Show when={error()}>
            <div
              role="alert"
              class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
            >
              {error()}
            </div>
          </Show>
          <Show when={mode() === "import" && busy()}>
            <p class="text-muted-foreground text-sm">
              Imported {progress()} of {rows().length} records…
            </p>
          </Show>
          <DialogFooter class="gap-2">
            <Button variant="outline" disabled={busy()} onClick={close}>
              Cancel
            </Button>
            <Show
              when={mode() === "export"}
              fallback={
                <Button
                  disabled={busy() || rows().length === 0 || Boolean(error())}
                  onClick={runImport}
                >
                  {busy() ? "Importing…" : "Import records"}
                </Button>
              }
            >
              <Button disabled={busy()} onClick={exportRows}>
                {busy() ? "Exporting…" : "Export"}
              </Button>
            </Show>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
