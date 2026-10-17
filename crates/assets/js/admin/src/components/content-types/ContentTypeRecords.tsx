import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import type {
  ColumnDef,
  PaginationState,
  SortingState,
  StockFeatures,
  Updater,
} from "@tanstack/solid-table";
import {
  TbOutlineForms,
  TbOutlinePlus,
  TbOutlineTable,
  TbOutlineTrash,
} from "solid-icons/tb";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SafeSheet } from "@/components/SafeSheet";
import { SheetContent } from "@/components/ui/sheet";
import { FilterBar } from "@/components/FilterBar";
import { InsertUpdateRowForm } from "@/components/explorer/InsertUpdateRow";
import { Table, buildTable } from "@/components/table/Table";
import { createTableSchemaQuery } from "@/lib/api/table";
import { fetchRows } from "@/lib/api/row";
import { formatSortingAsOrder } from "@/lib/list";
import { sqlValueToString } from "@/lib/value";
import { showToast } from "@/components/ui/toast";
import type { ArrayRecord, Record } from "@/lib/record";
import { parseQualifiedName } from "@/lib/qualified_name";
import { equalQualifiedNames } from "@/lib/schema";
import {
  updateContentTypeViews,
  type ContentTypeSchema,
  type ContentTypeView,
  type ContentTypeViews,
} from "@/lib/api/content-types";
import type { SqlValue, Table as TableSchema } from "trailbase-bindings";

type SavedView = ContentTypeView;

function defaultViews(): ContentTypeViews {
  return {
    version: 1,
    selectedViewId: "table",
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        filter: "",
        sort: [],
        columns: [],
        isDefault: true,
      },
      {
        id: "form",
        name: "Form",
        type: "form",
        filter: "",
        sort: [],
        columns: [],
        isDefault: true,
      },
    ],
  };
}

function withDefaultViews(views?: ContentTypeViews): ContentTypeViews {
  const defaults = defaultViews();
  const customViews = (views?.views ?? []).filter(
    (view) => view.id !== "table" && view.id !== "form" && !view.isDefault,
  );
  const allViews = [...defaults.views, ...customViews];
  const selectedViewId = allViews.some(
    (view) => view.id === views?.selectedViewId,
  )
    ? views!.selectedViewId
    : defaults.selectedViewId;
  return { ...defaults, ...views, views: allViews, selectedViewId };
}

function findBackingTable(
  contentType: ContentTypeSchema,
  tables: TableSchema[],
): TableSchema | undefined {
  if (!contentType.tableName) return undefined;
  let target;
  try {
    target = parseQualifiedName(contentType.tableName);
  } catch {
    target = {
      name: contentType.tableName,
      database_schema: contentType.databaseSchema ?? null,
    };
  }
  target.database_schema ??= contentType.databaseSchema ?? null;
  return tables.find((table) => equalQualifiedNames(table.name, target));
}

export function ContentTypeRecords(props: { schema: ContentTypeSchema }) {
  const tableSchemas = createTableSchemaQuery();
  const table = createMemo(() =>
    findBackingTable(
      props.schema,
      tableSchemas.data?.tables.map(([schema]) => schema) ?? [],
    ),
  );
  const [saved, setSaved] = createSignal<ContentTypeViews>(defaultViews());
  const [newViewName, setNewViewName] = createSignal("");
  const [addingView, setAddingView] = createSignal(false);
  const [editRow, setEditRow] = createSignal<Record>();
  const [formOpen, setFormOpen] = createSignal(false);
  const [pagination, setPagination] = createSignal<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });
  createEffect(() => {
    setSaved(withDefaultViews(props.schema.views));
  });

  let saveQueue = Promise.resolve();
  const persistViews = (next: ContentTypeViews) => {
    const uid = props.schema.uid;
    const normalized = withDefaultViews(next);
    setSaved(normalized);
    saveQueue = saveQueue
      .then(() => updateContentTypeViews(uid, normalized))
      .then(() => undefined)
      .catch((err: unknown) => {
        showToast({
          title: "Could not save views",
          description: String(err),
          variant: "error",
        });
      });
  };

  const activeView = createMemo(() =>
    saved().views.find((view) => view.id === saved().selectedViewId),
  );
  const customViews = createMemo(() =>
    saved().views.filter((view) => view.id !== "table" && view.id !== "form"),
  );
  const sorting = createMemo(() => (activeView()?.sort ?? []) as SortingState);
  const activeFilter = createMemo(() => activeView()?.filter ?? "");
  const rows = useQuery(() => ({
    queryKey: [
      "content-type-records",
      props.schema.uid,
      table()?.name,
      pagination().pageIndex,
      pagination().pageSize,
      activeFilter(),
      sorting(),
    ],
    enabled: !!table(),
    queryFn: async () => {
      const currentTable = table();
      if (!currentTable) return undefined;
      return fetchRows(
        currentTable.name,
        activeFilter() || null,
        pagination().pageSize,
        pagination().pageIndex,
        null,
        formatSortingAsOrder(sorting()),
      );
    },
  }));

  const columnDefs = createMemo<
    ColumnDef<StockFeatures, ArrayRecord, SqlValue>[]
  >(() =>
    (rows.data?.columns ?? table()?.columns ?? []).map((column, index) => ({
      id: column.name,
      accessorFn: (row) => row[index],
      header: column.name,
      enableSorting: true,
      cell: (context) => sqlValueToString(context.getValue() as SqlValue),
    })),
  );
  const data = createMemo(() => rows.data?.rows ?? []);
  const tableInstance = buildTable(
    {
      columns: columnDefs,
      data,
      rowCount: () => Number(rows.data?.total_row_count ?? 0n),
      pagination,
      onPaginationChange: (state) => setPagination(state),
    },
    {
      manualSorting: true,
      state: { sorting },
      onSortingChange: (updater: Updater<SortingState>) => {
        const current = sorting();
        const next = typeof updater === "function" ? updater(current) : updater;
        if (activeView() && !activeView()!.isDefault) {
          persistViews({
            ...saved(),
            views: saved().views.map((view) =>
              view.id === activeView()!.id ? { ...view, sort: next } : view,
            ),
          });
        }
        setPagination((current) => ({ ...current, pageIndex: 0 }));
      },
    },
  );

  const saveFilter = (value: string) => {
    if (!activeView()) return;
    persistViews({
      ...saved(),
      views: saved().views.map((view) =>
        view.id === saved().selectedViewId ? { ...view, filter: value } : view,
      ),
    });
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  const addView = () => {
    const name = newViewName().trim();
    if (!name) return;
    const view: SavedView = {
      id: crypto.randomUUID(),
      name,
      type: "table",
      filter: "",
      sort: [],
      columns: [],
      isDefault: false,
    };
    persistViews({
      ...saved(),
      views: [...saved().views, view],
      selectedViewId: view.id,
    });
    setNewViewName("");
    setAddingView(false);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  const removeActiveView = () => {
    const current = activeView();
    if (!current || current.isDefault) return;
    persistViews({
      ...saved(),
      views: saved().views.filter((view) => view.id !== current.id),
      selectedViewId: "table",
    });
  };

  const refetchRows = () => void rows.refetch();
  const rowToRecord = (row: ArrayRecord): Record =>
    Object.fromEntries(
      (rows.data?.columns ?? table()?.columns ?? []).map((column, index) => [
        column.name,
        row[index],
      ]),
    );

  return (
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <div class="flex flex-wrap items-center gap-1 border-b">
            <button
              type="button"
              class={`inline-flex h-9 items-center gap-2 border-b-2 px-3 text-sm ${saved().selectedViewId === "table" ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground border-transparent"}`}
              aria-pressed={saved().selectedViewId === "table"}
              onClick={() => {
                persistViews({ ...saved(), selectedViewId: "table" });
                setPagination((current) => ({ ...current, pageIndex: 0 }));
              }}
            >
              <TbOutlineTable /> Table
            </button>
            <button
              type="button"
              class={`inline-flex h-9 items-center gap-2 border-b-2 px-3 text-sm ${saved().selectedViewId === "form" ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground border-transparent"}`}
              aria-pressed={saved().selectedViewId === "form"}
              onClick={() => {
                persistViews({ ...saved(), selectedViewId: "form" });
                setPagination((current) => ({ ...current, pageIndex: 0 }));
              }}
            >
              <TbOutlineForms /> Form
            </button>
            <For each={customViews()}>
              {(view) => (
                <button
                  type="button"
                  class={`inline-flex h-9 items-center gap-2 border-b-2 px-3 text-sm ${saved().selectedViewId === view.id ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground border-transparent"}`}
                  aria-pressed={saved().selectedViewId === view.id}
                  onClick={() => {
                    persistViews({ ...saved(), selectedViewId: view.id });
                    setPagination((current) => ({ ...current, pageIndex: 0 }));
                  }}
                >
                  {view.name}
                </button>
              )}
            </For>
          </div>
          <Show when={activeView() && !activeView()!.isDefault}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${activeView()?.name} view`}
              onClick={removeActiveView}
            >
              <TbOutlineTrash />
            </Button>
          </Show>
          <Show when={addingView()}>
            <form
              class="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                addView();
              }}
            >
              <input
                class="border-input bg-background focus-visible:ring-ring h-9 w-40 rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
                aria-label="New view name"
                placeholder="View name"
                value={newViewName()}
                onInput={(event) => setNewViewName(event.currentTarget.value)}
                autofocus
              />
              <Button size="sm" type="submit">
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  setAddingView(false);
                  setNewViewName("");
                }}
              >
                Cancel
              </Button>
            </form>
          </Show>
          <Show when={!addingView()}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAddingView(true)}
            >
              <TbOutlinePlus /> Add view
            </Button>
          </Show>
        </div>

        <Show when={activeView()?.id !== "form"}>
          <SafeSheet open={[formOpen, setFormOpen]}>
            {(sheet) => (
              <>
                <SheetContent class="w-[90vw] sm:max-w-2xl">
                  <Show
                    when={table()}
                    fallback={<div class="text-sm">Loading table schema…</div>}
                  >
                    <InsertUpdateRowForm
                      schema={table()!}
                      rowsRefetch={refetchRows}
                      row={editRow()}
                      {...sheet}
                    />
                  </Show>
                </SheetContent>
                <Button
                  onClick={() => {
                    setEditRow(undefined);
                    setFormOpen(true);
                  }}
                >
                  <TbOutlinePlus /> Add content
                </Button>
              </>
            )}
          </SafeSheet>
        </Show>
      </div>

      <Show when={tableSchemas.isError}>
        <p role="alert" class="text-destructive text-sm">
          Could not load the content table schema: {String(tableSchemas.error)}
        </p>
      </Show>
      <Show when={!tableSchemas.isPending && !table()}>
        <p class="text-muted-foreground rounded-md border p-4 text-sm">
          This content type has no collection table to browse.
        </p>
      </Show>
      <Show when={table()}>
        <Show when={activeView()?.id === "form"}>
          <div class="w-full">
            <Card>
              <CardContent class="p-5">
                <Show when={table()}>
                  <InsertUpdateRowForm
                    inline
                    schema={table()!}
                    rowsRefetch={refetchRows}
                    close={() => undefined}
                    markDirty={() => undefined}
                  />
                </Show>
              </CardContent>
            </Card>
          </div>
        </Show>
        <Show when={activeView()?.id !== "form"}>
          <Show when={activeView()?.id !== "table"}>
            <FilterBar
              initial={activeFilter()}
              onSubmit={saveFilter}
              placeholder="Filter, e.g. &quot;status = 'published'&quot;"
            />
          </Show>
          <Show when={rows.isError}>
            <p role="alert" class="text-destructive text-sm">
              Could not load records: {String(rows.error)}
            </p>
          </Show>
          <div class="overflow-x-auto">
            <Table
              table={tableInstance}
              loading={rows.isPending || rows.isFetching}
              onRowClick={(_index, row) => {
                setEditRow(rowToRecord(row));
                setFormOpen(true);
              }}
            />
          </div>
          <p class="text-muted-foreground text-right text-xs">
            {Number(rows.data?.total_row_count ?? 0n)} records
          </p>
        </Show>
      </Show>
    </section>
  );
}
