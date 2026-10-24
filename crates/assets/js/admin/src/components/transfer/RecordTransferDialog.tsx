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
import {
  applyJqMapping,
  downloadContent,
  exportTableRecords,
  importTableRecords,
  inspectRecordSource,
  parseImportDocument,
  schemaMatchError,
} from "@/lib/data-transfer";

const inputStyle =
  "border-input bg-background h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
type ImportFormat = "json" | "yaml" | "csv" | "tsv" | "ndjson" | "xml";

export function RecordTransferDialog(props: {
  table: Table;
  onImported: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [mode, setMode] = createSignal<"import" | "export">("import");
  const [format, setFormat] = createSignal<"json" | "yaml" | "csv">("json");
  const [importFormat, setImportFormat] = createSignal<ImportFormat>("json");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [rows, setRows] = createSignal<Record<string, unknown>[]>([]);
  const [root, setRoot] = createSignal<unknown>();
  const [mapping, setMapping] = createSignal("");
  const [mappingRequired, setMappingRequired] = createSignal(false);
  const [filename, setFilename] = createSignal("");
  const [progress, setProgress] = createSignal(0);
  const [sourceSample, setSourceSample] = createSignal("");
  const [selectedFile, setSelectedFile] = createSignal<File>();
  let fileInput!: HTMLInputElement;
  const acceptedImportTypes = () =>
    ({
      json: ".json",
      yaml: ".yaml,.yml",
      csv: ".csv",
      tsv: ".tsv",
      ndjson: ".ndjson,.jsonl",
      xml: ".xml",
    })[importFormat()];

  function close() {
    if (busy()) return;
    setOpen(false);
    setError(undefined);
  }

  async function loadFile(file: File, selectedFormat = importFormat()) {
    setRows([]);
    setSelectedFile(undefined);
    setError(undefined);
    try {
      const parsed = parseImportDocument(
        await file.text(),
        `import.${selectedFormat}`,
      );
      const source = inspectRecordSource(parsed);
      const mismatch = schemaMatchError(props.table, source.records);
      setRoot(parsed);
      setFilename(file.name);
      setSelectedFile(file);
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
      setRows([]);
      setSelectedFile(undefined);
      setError(err instanceof Error ? err.message : String(err));
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
      setError(schemaMatchError(props.table, mapped));
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function exportRows() {
    setBusy(true);
    setError(undefined);
    try {
      const records = await exportTableRecords(props.table, format());
      const tableName = props.table.name.name;
      downloadContent(
        `${tableName}.${format()}`,
        records,
        "application/octet-stream",
      );
      setOpen(false);
      showToast({
        title: "Export complete",
        description: `Exported ${tableName} as ${format().toUpperCase()}.`,
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
      await importTableRecords(props.table, rows(), setProgress);
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
        accept={acceptedImportTypes()}
        class="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void loadFile(file);
        }}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setMode("import");
          setImportFormat("json");
          setSelectedFile(undefined);
          setRows([]);
          setFilename("");
          setRoot(undefined);
          setMapping("");
          setMappingRequired(false);
          setError(undefined);
          setOpen(true);
        }}
      >
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
                    {selectedFile()
                      ? `${rows().length} rows from ${filename()}. The selected table defines the expected columns.`
                      : "Choose a file type and select a file to import into this table."}
                  </DialogDescription>
                </DialogHeader>
                <div class="flex flex-wrap items-end gap-3">
                  <label class="flex min-w-40 flex-col gap-1.5 text-sm font-medium">
                    File type
                    <select
                      class={inputStyle}
                      value={importFormat()}
                      onChange={(event) => {
                        const next = event.currentTarget.value as ImportFormat;
                        setImportFormat(next);
                        const file = selectedFile();
                        if (file) void loadFile(file, next);
                      }}
                    >
                      <option value="json">JSON</option>
                      <option value="yaml">YAML</option>
                      <option value="csv">CSV</option>
                      <option value="tsv">TSV</option>
                      <option value="ndjson">JSON Lines</option>
                      <option value="xml">XML</option>
                    </select>
                  </label>
                  <Button
                    variant="outline"
                    disabled={busy()}
                    onClick={() => fileInput.click()}
                  >
                    {selectedFile() ? "Choose another file" : "Choose file"}
                  </Button>
                </div>
                <Show when={mappingRequired()}>
                  <div class="flex flex-col gap-3">
                    <p class="text-sm">
                      The file shape differs from this table. Map the data to
                      the selected table fields.
                    </p>
                    <MappingEditor
                      source={root()}
                      targetFields={props.table.columns
                        .filter(
                          (column) =>
                            !column.options.some(
                              (option) =>
                                typeof option === "object" &&
                                "Generated" in option,
                            ),
                        )
                        .map((column) => column.name)}
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
                  setFormat(
                    event.currentTarget.value as "json" | "yaml" | "csv",
                  )
                }
              >
                <option value="json">JSON</option>
                <option value="yaml">YAML</option>
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
