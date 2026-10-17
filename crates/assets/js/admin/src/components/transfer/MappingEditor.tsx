import { For, createEffect, createSignal } from "solid-js";

import { Button } from "@/components/ui/button";
import { inspectRecordSource } from "@/lib/content-type-transfer";

const inputStyle =
  "border-input bg-background h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function jqPath(name: string) {
  return /^[A-Za-z_][\w]*$/.test(name)
    ? `.${name}`
    : `.[${JSON.stringify(name)}]`;
}

function fieldsFrom(source: unknown) {
  try {
    const inspected = inspectRecordSource(source);
    return {
      selector: inspected.selector,
      fields: Object.keys(inspected.records[0] ?? {}),
    };
  } catch {
    return { selector: ".", fields: [] as string[] };
  }
}

export function MappingEditor(props: {
  source: unknown;
  targetFields: string[];
  targetLabel?: string;
  expression: string;
  onExpressionChange: (expression: string) => void;
}) {
  const [mode, setMode] = createSignal<"nodes" | "table" | "jq">("nodes");
  const [sourceFields, setSourceFields] = createSignal<string[]>([]);
  const [selector, setSelector] = createSignal(".");
  const [fieldMappings, setFieldMappings] = createSignal<
    Record<string, string>
  >({});
  const [activeSource, setActiveSource] = createSignal<string>();

  function updateMap(next: Record<string, string>) {
    setFieldMappings(next);
    const pairs = Object.entries(next)
      .filter(([, source]) => source)
      .map(
        ([target, source]) => `${JSON.stringify(target)}: ${jqPath(source)}`,
      );
    props.onExpressionChange(`${selector()} | { ${pairs.join(", ")} }`);
  }

  createEffect(() => {
    const source = props.source;
    const targets = props.targetFields;
    const inspected = fieldsFrom(source);
    setSelector(inspected.selector);
    setSourceFields(inspected.fields);
    const initial: Record<string, string> = {};
    for (const target of targets) {
      const match = inspected.fields.find(
        (field) =>
          field === target ||
          field.toLowerCase().replace(/[^a-z0-9]/g, "") ===
            target.toLowerCase().replace(/[^a-z0-9]/g, ""),
      );
      if (match) initial[target] = match;
    }
    updateMap(initial);
  });

  function connect(target: string, source: string) {
    updateMap({ ...fieldMappings(), [target]: source });
    setActiveSource(undefined);
  }

  return (
    <div class="flex flex-col gap-3">
      <div
        class="flex flex-wrap gap-1 border-b pb-2"
        aria-label="Mapping editor"
      >
        <Button
          size="sm"
          variant={mode() === "nodes" ? "default" : "ghost"}
          aria-pressed={mode() === "nodes"}
          onClick={() => setMode("nodes")}
        >
          Nodes
        </Button>
        <Button
          size="sm"
          variant={mode() === "table" ? "default" : "ghost"}
          aria-pressed={mode() === "table"}
          onClick={() => setMode("table")}
        >
          Table
        </Button>
        <Button
          size="sm"
          variant={mode() === "jq" ? "default" : "ghost"}
          aria-pressed={mode() === "jq"}
          onClick={() => setMode("jq")}
        >
          jq
        </Button>
      </div>

      {mode() === "nodes" && (
        <>
          <div class="bg-muted/20 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3 rounded-md border p-3">
            <div class="min-w-0">
              <div class="mb-2 text-xs font-semibold">File fields</div>
              <div class="flex flex-col gap-1.5">
                <For each={sourceFields()}>
                  {(field) => (
                    <button
                      type="button"
                      class={`bg-background min-w-0 truncate rounded border px-2.5 py-2 text-left text-sm ${activeSource() === field ? "border-primary ring-primary ring-1" : ""}`}
                      aria-pressed={activeSource() === field}
                      onClick={() => setActiveSource(field)}
                    >
                      {field}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <div class="flex min-w-16 flex-col items-center justify-center gap-2 px-1">
              <span class="text-muted-foreground text-xs">Connect</span>
              <For
                each={Object.entries(fieldMappings()).filter(
                  ([, source]) => source,
                )}
              >
                {([target, source]) => (
                  <span
                    class="text-primary max-w-28 truncate text-xs"
                    title={`${source} → ${target}`}
                  >
                    {source} → {target}
                  </span>
                )}
              </For>
            </div>
            <div class="min-w-0">
              <div class="mb-2 text-xs font-semibold">
                {props.targetLabel ?? "Target fields"}
              </div>
              <div class="flex flex-col gap-1.5">
                <For each={props.targetFields}>
                  {(target) => (
                    <button
                      type="button"
                      class={`bg-background min-w-0 truncate rounded border px-2.5 py-2 text-left text-sm ${fieldMappings()[target] ? "border-primary/50" : ""}`}
                      onClick={() =>
                        activeSource() && connect(target, activeSource()!)
                      }
                      title={
                        activeSource()
                          ? `Connect ${activeSource()} to ${target}`
                          : "Select a file field first"
                      }
                    >
                      <span>{target}</span>
                      <span class="text-muted-foreground ml-2 text-xs">
                        {fieldMappings()[target]
                          ? `← ${fieldMappings()[target]}`
                          : "Unmapped"}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
          <p class="text-muted-foreground m-0 text-xs">
            Select a file field, then select the target field it should fill.
          </p>
        </>
      )}

      {mode() === "table" && (
        <div class="max-h-64 overflow-auto rounded-md border">
          <div class="bg-muted/40 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3 border-b px-3 py-2 text-xs font-semibold">
            <span>File field</span>
            <span></span>
            <span>{props.targetLabel ?? "Target field"}</span>
          </div>
          <For each={props.targetFields}>
            {(target) => (
              <label class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b p-2 last:border-b-0">
                <select
                  class={inputStyle}
                  value={fieldMappings()[target] ?? ""}
                  onChange={(event) =>
                    connect(target, event.currentTarget.value)
                  }
                >
                  <option value="">Leave unmapped</option>
                  <For each={sourceFields()}>
                    {(source) => <option value={source}>{source}</option>}
                  </For>
                </select>
                <span class="text-muted-foreground text-xs">maps to</span>
                <span class="truncate text-sm font-medium">{target}</span>
              </label>
            )}
          </For>
        </div>
      )}

      {mode() === "jq" && (
        <>
          <label class="flex flex-col gap-1.5 text-sm font-medium">
            jq expression
            <textarea
              class={`${inputStyle} min-h-28 resize-y py-2 font-mono`}
              value={props.expression}
              onInput={(event) =>
                props.onExpressionChange(event.currentTarget.value)
              }
              spellcheck={false}
            />
          </label>
          <p class="text-muted-foreground m-0 text-xs">
            Supports paths, array selection, object mapping, and <code>//</code>
            fallback. Example:{" "}
            <code>.items[] | &#123; title: .name &#125;</code>.
          </p>
        </>
      )}
    </div>
  );
}
