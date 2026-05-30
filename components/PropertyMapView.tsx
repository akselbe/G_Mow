"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map,
} from "maplibre-gl";

import { fetchAllProperties } from "@/lib/fetchAllProperties";
import {
  clonePropertyRows,
  syncPropertiesToSnapshot,
} from "@/lib/syncPropertiesUndo";
import { supabase } from "@/lib/supabase";
import {
  PROPERTY_STATUSES,
  STATUS_MAP_COLORS,
  calculateMowingPrice,
  formatAddress,
  formatLastEdited,
  rowsToFeatureCollection,
  statusColorMatchExpression,
  type GeoJsonFeatureCollection,
  type PropertyDetails,
  type PropertyRow,
} from "@/lib/properties";

const GARUPE_CENTER: [number, number] = [24.24, 57.12];
const INITIAL_ZOOM = 14.5;
const SOURCE_ID = "properties";
const FILL_LAYER_ID = "properties-fill";
const OUTLINE_LAYER_ID = "properties-outline";
const INTERACTIVE_LAYERS = [FILL_LAYER_ID, OUTLINE_LAYER_ID];

const emptyDetails = (): PropertyDetails => ({
  id: "",
  cadastre_number: null,
  street_name: null,
  house_number: null,
  area_sqm: null,
  client_name: null,
  phone: null,
  email: null,
  mowing_price: null,
  is_archived: false,
  last_edited_at: null,
  status: null,
  services: [],
});

function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function detailsFromFeatureProps(
  props: Record<string, unknown>
): PropertyDetails {
  let parsedServices: string[] = [];
  if (Array.isArray(props.services)) {
    parsedServices = props.services;
  } else if (typeof props.services === "string") {
    try {
      parsedServices = JSON.parse(props.services);
    } catch {}
  }

  return {
    id: String(props.id),
    cadastre_number: parseOptionalString(props.cadastre_number),
    street_name: parseOptionalString(props.street_name),
    house_number: parseOptionalString(props.house_number),
    area_sqm: parseOptionalNumber(props.area_sqm),
    client_name: parseOptionalString(props.client_name),
    phone: parseOptionalString(props.phone),
    email: parseOptionalString(props.email),
    mowing_price: parseOptionalNumber(props.mowing_price),
    is_archived: props.is_archived === true,
    last_edited_at: parseOptionalString(props.last_edited_at),
    status: parseOptionalString(props.status),
    services: parsedServices,
  };
}

function detailsFromRow(row: PropertyRow): PropertyDetails {
  const { geom: _geom, ...details } = row;
  return details;
}

function isMultiSelectKey(e: MouseEvent | PointerEvent): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey;
}

type UndoSnapshot = {
  label: string;
  properties: PropertyRow[];
  selectedIds: string[];
  selected: PropertyDetails | null;
  panelOpen: boolean;
  draft: PropertyDetails;
};

export default function PropertyMapView() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const hoveredIdRef = useRef<string | number | null>(null);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const geojsonRef = useRef<GeoJsonFeatureCollection | null>(null);
  const onParcelClickRef = useRef<
    (details: PropertyDetails, additive: boolean) => void
  >(() => {});
  const onClearSelectionRef = useRef<() => void>(() => {});
  const selectedIdsListRef = useRef<string[]>([]);

  const [properties, setProperties] = useState<PropertyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PropertyDetails | null>(null);
  const [draft, setDraft] = useState<PropertyDetails>(emptyDetails());

  const [bulkStatus, setBulkStatus] = useState<string>("active");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [infoPaneOpen, setInfoPaneOpen] = useState(false);
  const [undoSnapshot, setUndoSnapshot] = useState<UndoSnapshot | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const captureUndo = useCallback(
    (label: string): UndoSnapshot => ({
      label,
      properties: clonePropertyRows(properties),
      selectedIds: [...selectedIds],
      selected: selected ? { ...selected } : null,
      panelOpen,
      draft: { ...draft },
    }),
    [properties, selectedIds, selected, panelOpen, draft]
  );

  const syncMapData = useCallback((collection: GeoJsonFeatureCollection) => {
    geojsonRef.current = collection;
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;

    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData(collection as unknown as GeoJSON.FeatureCollection);
    }
  }, []);

  const applyMapSelection = useCallback((ids: string[]) => {
    const map = mapRef.current;
    if (!map) return;

    const nextSet = new Set(ids);
    for (const id of selectedIdsRef.current) {
      if (!nextSet.has(id)) {
        map.removeFeatureState({ source: SOURCE_ID, id });
      }
    }
    for (const id of nextSet) {
      if (!selectedIdsRef.current.has(id)) {
        map.setFeatureState({ source: SOURCE_ID, id }, { selected: true });
      }
    }
    selectedIdsRef.current = nextSet;
  }, []);

  const restoreUiFromUndo = useCallback(
    (snapshot: UndoSnapshot) => {
      applyMapSelection(snapshot.selectedIds);
      setSelectedIds(snapshot.selectedIds);
      setPanelOpen(snapshot.panelOpen);
      setSelected(snapshot.selected);
      setDraft(snapshot.draft);
      setSaveError(null);
      setBulkError(null);
    },
    [applyMapSelection]
  );

  const handleUndo = useCallback(async () => {
    if (!undoSnapshot) return;

    setUndoing(true);
    setUndoError(null);

    const { error } = await syncPropertiesToSnapshot(
      supabase,
      undoSnapshot.properties,
      properties
    );

    if (error) {
      setUndoError(error);
      setUndoing(false);
      return;
    }

    setProperties(undoSnapshot.properties);
    syncMapData(rowsToFeatureCollection(undoSnapshot.properties));
    restoreUiFromUndo(undoSnapshot);
    setUndoSnapshot(null);
    setUndoing(false);
  }, [undoSnapshot, properties, syncMapData, restoreUiFromUndo]);

  const clearSelection = useCallback(() => {
    applyMapSelection([]);
    setSelectedIds([]);
    setPanelOpen(false);
    setDeleting(false);
    setSaving(false);
    setSaveError(null);
    setBulkError(null);
    setSelected(null);
  }, [applyMapSelection]);

  const updateSelection = useCallback(
    (nextIds: string[], lastClicked?: PropertyDetails) => {
      applyMapSelection(nextIds);
      setSelectedIds(nextIds);
      setSaveError(null);
      setBulkError(null);

      if (nextIds.length === 0) {
        setPanelOpen(false);
      setSelected(null);
        return;
      }

      if (nextIds.length === 1) {
        const row = properties.find((r) => r.id === nextIds[0]);
        const details = row ? detailsFromRow(row) : lastClicked;
        if (details) {
          setSelected(details);
          setDraft(details);
          setPanelOpen(true);
        }
        return;
      }

      setPanelOpen(false);
      setSelected(null);
    },
    [applyMapSelection, properties]
  );

  const handleParcelClick = useCallback(
    (details: PropertyDetails, additive: boolean) => {
      const prev = selectedIdsListRef.current;
      const next = additive
        ? prev.includes(details.id)
          ? prev.filter((id) => id !== details.id)
          : [...prev, details.id]
        : [details.id];
      updateSelection(next, details);
    },
    [updateSelection]
  );

  useEffect(() => {
    selectedIdsListRef.current = selectedIds;
  }, [selectedIds]);

  useEffect(() => {
    onParcelClickRef.current = handleParcelClick;
    onClearSelectionRef.current = clearSelection;
  }, [handleParcelClick, clearSelection]);

  const loadProperties = useCallback(async () => {
    setLoading(true);
    setFetchError(null);

    const { rows, error } = await fetchAllProperties();

    if (error) {
      setFetchError(error);
      setLoading(false);
      return;
    }

    setProperties(rows);
    syncMapData(rowsToFeatureCollection(rows));
    setUndoSnapshot(null);
    setLoading(false);
  }, [syncMapData]);

  useEffect(() => {
    loadProperties();
  }, [loadProperties]);

  useEffect(() => {
    if (mapReady && properties.length > 0) {
      syncMapData(rowsToFeatureCollection(properties));
    }
  }, [mapReady, properties, syncMapData]);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    let map: Map;

    try {
      map = new maplibregl.Map({
        container,
        center: GARUPE_CENTER,
        zoom: INITIAL_ZOOM,
        style: {
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            },
          },
          layers: [
            {
              id: "osm",
              type: "raster",
              source: "osm",
            },
          ],
        },
      });
    } catch (err) {
      setMapError(err instanceof Error ? err.message : "Failed to start map");
      return;
    }

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;

    const onResize = () => map.resize();
    window.addEventListener("resize", onResize);

    map.on("error", (e) => {
      console.error("MapLibre error:", e.error?.message ?? e);
    });

    map.on("load", () => {
      map.resize();

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: (geojsonRef.current ?? {
          type: "FeatureCollection",
          features: [],
        }) as unknown as GeoJSON.FeatureCollection,
        promoteId: "id",
      });

      map.addLayer({
        id: FILL_LAYER_ID,
        type: "fill",
        source: SOURCE_ID,
        paint: {
          "fill-color": statusColorMatchExpression(
            "fill"
          ) as ExpressionSpecification,
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.65,
            ["boolean", ["feature-state", "hover"], false],
            0.58,
            0.42,
          ],
        },
      });

      map.addLayer({
        id: OUTLINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": statusColorMatchExpression(
            "outline"
          ) as ExpressionSpecification,
          "line-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            2.5,
            ["boolean", ["feature-state", "hover"], false],
            2,
            1.25,
          ],
        },
      });

      const clearHover = () => {
        if (hoveredIdRef.current !== null) {
          map.setFeatureState(
            { source: SOURCE_ID, id: hoveredIdRef.current },
            { hover: false }
          );
          hoveredIdRef.current = null;
        }
        map.getCanvas().style.cursor = "";
      };

      map.on("mousemove", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: INTERACTIVE_LAYERS,
        });

        if (!features.length) {
          clearHover();
          return;
        }

        map.getCanvas().style.cursor = "pointer";
        const featureId = features[0].id;

        if (featureId === undefined || featureId === hoveredIdRef.current) {
          return;
        }

        clearHover();
        hoveredIdRef.current = featureId;
        map.setFeatureState(
          { source: SOURCE_ID, id: featureId },
          { hover: true }
        );
      });

      map.on("mouseleave", clearHover);

      map.on("click", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: INTERACTIVE_LAYERS,
        });

        if (!features.length) {
          onClearSelectionRef.current();
          return;
        }

        const props = features[0].properties as Record<string, unknown> | null;
        if (!props?.id) return;

        const details = detailsFromFeatureProps(props);
        const additive = isMultiSelectKey(e.originalEvent);
        onParcelClickRef.current(details, additive);
      });

      setMapReady(true);
    });

    return () => {
      window.removeEventListener("resize", onResize);
      map.remove();
      mapRef.current = null;
      selectedIdsRef.current = new Set();
      setMapReady(false);
    };
  }, []);

  const closePanel = () => {
    clearSelection();
  };

  const handleSave = async () => {
    if (!selected) return;

    setSaving(true);
    setSaveError(null);

    const payload = {
      client_name: draft.client_name?.trim() || null,
      phone: draft.phone?.trim() || null,
      email: draft.email?.trim() || null,
      mowing_price:
        draft.mowing_price === null || draft.mowing_price === undefined
          ? null
          : Number(draft.mowing_price),
      status: draft.status?.trim() || null,
      services: draft.services || [],
      last_edited_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("properties")
      .update(payload)
      .eq("id", selected.id);

    if (error) {
      setSaveError(error.message);
      setSaving(false);
      return;
    }

    setUndoSnapshot(captureUndo("Saved property"));

    const updatedRows = properties.map((row) =>
      row.id === selected.id ? { ...row, ...payload } : row
    );
    setProperties(updatedRows);
    syncMapData(rowsToFeatureCollection(updatedRows));

    const saved: PropertyDetails = {
      ...selected,
      ...payload,
      cadastre_number: selected.cadastre_number,
      street_name: selected.street_name,
      house_number: selected.house_number,
      area_sqm: selected.area_sqm,
    };
    setSelected(saved);
    setDraft(saved);
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!selected) return;

    setDeleting(true);
    setSaveError(null);

    const { error } = await supabase
      .from("properties")
      .delete()
      .eq("id", selected.id);

    if (error) {
      setSaveError(error.message);
      setDeleting(false);
      return;
    }

    setUndoSnapshot(captureUndo("Deleted property"));

    const updatedRows = properties.filter((row) => row.id !== selected.id);
    setProperties(updatedRows);
    syncMapData(rowsToFeatureCollection(updatedRows));
    clearSelection();
    setDeleting(false);
  };

  const handleBulkStatusUpdate = async () => {
    if (selectedIds.length < 2) return;

    setBulkSaving(true);
    setBulkError(null);

    const status = bulkStatus.trim() || null;
    const { error } = await supabase
      .from("properties")
      .update({ status })
      .in("id", selectedIds);

    if (error) {
      setBulkError(error.message);
      setBulkSaving(false);
      return;
    }

    setUndoSnapshot(captureUndo(`Updated status on ${selectedIds.length} parcels`));

    const idSet = new Set(selectedIds);
    const updatedRows = properties.map((row) =>
      idSet.has(row.id) ? { ...row, status } : row
    );
    setProperties(updatedRows);
    syncMapData(rowsToFeatureCollection(updatedRows));
    setBulkSaving(false);
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length < 2) return;

    setBulkDeleting(true);
    setBulkError(null);

    const { error } = await supabase
      .from("properties")
      .delete()
      .in("id", selectedIds);

    if (error) {
      setBulkError(error.message);
      setBulkDeleting(false);
      return;
    }

    setUndoSnapshot(captureUndo(`Deleted ${selectedIds.length} parcels`));

    const idSet = new Set(selectedIds);
    const updatedRows = properties.filter((row) => !idSet.has(row.id));
    setProperties(updatedRows);
    syncMapData(rowsToFeatureCollection(updatedRows));
    clearSelection();
    setBulkDeleting(false);
  };

  const displayValue = (value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === "") {
      return "—";
    }
    return String(value);
  };

  const parcelCount = rowsToFeatureCollection(properties).features.length;
  const bulkMode = selectedIds.length >= 2;
  const bulkBusy = bulkSaving || bulkDeleting;

  const isDirty = selected ? (
    draft.client_name !== selected.client_name ||
    draft.phone !== selected.phone ||
    draft.email !== selected.email ||
    draft.mowing_price !== selected.mowing_price ||
    draft.status !== selected.status ||
    JSON.stringify(draft.services || []) !== JSON.stringify(selected.services || [])
  ) : false;

  return (
    <div
      className="relative w-full overflow-hidden bg-zinc-200"
      style={{ height: "100dvh", minHeight: "100vh" }}
    >
      <div
        ref={mapContainerRef}
        className="absolute inset-0 h-full w-full"
        style={{ minHeight: "100dvh" }}
      />

      {!mapReady && !mapError && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-zinc-100/80">
          <p className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow">
            Loading map…
          </p>
        </div>
      )}

      {undoSnapshot && (
        <div className="absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoing || saving || deleting || bulkBusy}
            className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {undoing ? "Undoing…" : `Undo: ${undoSnapshot.label}`}
          </button>
          {undoError && (
            <p className="max-w-xs rounded-lg bg-red-50 px-3 py-2 text-center text-xs text-red-700 shadow">
              {undoError}
            </p>
          )}
        </div>
      )}

      <div className="absolute left-4 top-4 z-10 max-w-sm text-sm">
        {!infoPaneOpen ? (
          <button
            type="button"
            onClick={() => setInfoPaneOpen(true)}
            aria-expanded={false}
            aria-controls="map-info-pane"
            className="flex items-center gap-2 rounded-lg bg-white/95 px-3 py-2 font-medium text-zinc-900 shadow-md ring-1 ring-zinc-200 transition hover:bg-white"
          >
            <span>Garupe Mow</span>
            {selectedIds.length > 0 && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">
                {selectedIds.length}
              </span>
            )}
            {!loading && !fetchError && parcelCount > 0 && (
              <span className="text-xs font-normal text-zinc-500">
                {parcelCount}
              </span>
            )}
          </button>
        ) : (
          <div
            id="map-info-pane"
            className="rounded-lg bg-white/95 px-4 py-2 shadow-md ring-1 ring-zinc-200"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium text-zinc-900">Garupe Mow</p>
              <button
                type="button"
                onClick={() => setInfoPaneOpen(false)}
                aria-expanded={true}
                aria-controls="map-info-pane"
                className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
              >
                Minimize
              </button>
            </div>
            {loading && <p className="mt-1 text-zinc-600">Loading properties…</p>}
            {!loading && !fetchError && (
              <p className="mt-1 text-zinc-600">
                {parcelCount > 0
                  ? `${parcelCount} parcels on map`
                  : "No parcels to display"}
              </p>
            )}
            {selectedIds.length > 0 && (
              <p className="mt-1 font-medium text-green-800">
                {selectedIds.length} selected
              </p>
            )}
            <p className="mt-1 text-xs text-zinc-500">
              Ctrl+click (⌘ on Mac) to select multiple. Click empty map to
              clear.
            </p>
            <ul className="mt-2 space-y-1 border-t border-zinc-200 pt-2">
              {PROPERTY_STATUSES.map((status) => (
                <li
                  key={status}
                  className="flex items-center gap-2 text-xs text-zinc-700 capitalize"
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-zinc-300"
                    style={{
                      backgroundColor: STATUS_MAP_COLORS[status].fill,
                    }}
                  />
                  {status}
                </li>
              ))}
            </ul>
            {fetchError && (
              <p className="mt-1 text-red-600">Failed to load: {fetchError}</p>
            )}
            {mapError && (
              <p className="mt-1 text-red-600">Map error: {mapError}</p>
            )}
          </div>
        )}
      </div>

      {bulkMode && (
        <aside className="absolute right-0 top-0 z-20 flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">
                Bulk actions
              </h2>
              <p className="text-xs text-zinc-500">
                {selectedIds.length} parcels selected
              </p>
            </div>
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkBusy}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear
            </button>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Set status for all selected
              </label>
              <select
                value={bulkStatus}
                onChange={(e) => setBulkStatus(e.target.value)}
                disabled={bulkBusy}
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2 disabled:opacity-60"
              >
                {PROPERTY_STATUSES.map((status) => (
                  <option key={status} value={status} className="capitalize">
                    {status}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-zinc-500">
                Applies the same status to every selected parcel.
              </p>
            </div>

            <button
              type="button"
              onClick={handleBulkStatusUpdate}
              disabled={bulkBusy}
              className="w-full rounded-lg bg-green-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {bulkSaving ? "Updating…" : "Apply status"}
            </button>

            {bulkError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {bulkError}
              </p>
            )}
          </div>

          <div className="border-t border-zinc-200 px-6 py-4">
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkBusy}
              className="w-full rounded-lg border border-red-300 px-4 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkDeleting
                ? "Deleting…"
                : `Delete ${selectedIds.length} parcels`}
            </button>
          </div>
        </aside>
      )}

      {panelOpen && selected && selectedIds.length === 1 && !bulkMode && (
        <aside className="absolute right-0 top-0 z-20 flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">Property</h2>
              {selected.cadastre_number && (
                <p className="text-xs text-zinc-500">
                  Cadastre {selected.cadastre_number}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={closePanel}
              disabled={saving || deleting}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Close
            </button>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Address
              </label>
              <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-900">
                {displayValue(
                  formatAddress(selected.street_name, selected.house_number)
                )}
              </p>
            </div>

            {(
              [
                ["client_name", "Client name", "text"],
                ["phone", "Phone", "tel"],
                ["email", "Email", "email"],
              ] as const
            ).map(([key, label, inputType]) => (
              <div key={key}>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                  {label}
                </label>
                <input
                  type={inputType}
                  value={
                    draft[key] === null || draft[key] === undefined
                      ? ""
                      : String(draft[key])
                  }
                  onChange={(e) => {
                    const raw = e.target.value;
                    setDraft((prev) => ({
                      ...prev,
                      [key]: raw || null,
                    }));
                  }}
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
                />
              </div>
            ))}

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Area (m²)
              </label>
              <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-900">
                {selected.area_sqm !== null && selected.area_sqm !== undefined
                  ? selected.area_sqm.toLocaleString()
                  : "—"}
              </p>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Mowing price (€)
                </label>
                {selected.area_sqm !== null && selected.area_sqm !== undefined && (
                  <button
                    type="button"
                    onClick={() => {
                      const calculated = calculateMowingPrice(
                        selected.area_sqm!,
                        draft.services?.includes("trimming") ?? false,
                        draft.services?.includes("outside") ?? false
                      );
                      setDraft((prev) => ({ ...prev, mowing_price: calculated }));
                    }}
                    className="text-xs font-medium text-green-600 transition hover:text-green-700"
                  >
                    Auto-calculate
                  </button>
                )}
              </div>
              <input
                type="number"
                value={
                  draft.mowing_price === null ||
                  draft.mowing_price === undefined
                    ? ""
                    : String(draft.mowing_price)
                }
                onChange={(e) => {
                  const raw = e.target.value;
                  setDraft((prev) => ({
                    ...prev,
                    mowing_price: raw === "" ? null : Number(raw),
                  }));
                }}
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Status
              </label>
              <select
                value={draft.status ?? ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    status: e.target.value || null,
                  }))
                }
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
              >
                {PROPERTY_STATUSES.map((status) => (
                  <option key={status} value={status} className="capitalize">
                    {status}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Services
              </label>
              <div className="flex flex-col gap-3 rounded-lg border border-zinc-300 p-3">
                <div className="flex flex-wrap gap-2">
                  {["mowing", "trimming", "outside"].map((service) => {
                    const isSelected = draft.services?.includes(service) ?? false;
                    return (
                      <label
                        key={service}
                        className={`cursor-pointer select-none rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          isSelected
                            ? "bg-green-100 text-green-800 ring-1 ring-green-600/20"
                            : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={isSelected}
                          onChange={(e) => {
                            const currentServices = draft.services || [];
                            const checked = e.target.checked;
                            setDraft((prev) => ({
                              ...prev,
                              services: checked
                                ? [...currentServices, service]
                                : currentServices.filter((s) => s !== service),
                            }));
                          }}
                        />
                        <span className="capitalize">{service}</span>
                      </label>
                    );
                  })}
                </div>

                <div className="flex flex-wrap gap-2">
                  {(draft.services || [])
                    .filter((s) => !["mowing", "trimming", "outside"].includes(s))
                    .map((service) => (
                      <span
                        key={service}
                        className="flex items-center gap-1.5 rounded-full bg-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700"
                      >
                        {service}
                        <button
                          type="button"
                          onClick={() => {
                            setDraft((prev) => ({
                              ...prev,
                              services: (prev.services || []).filter((s) => s !== service),
                            }));
                          }}
                          className="text-zinc-500 transition hover:text-zinc-900"
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Add custom tag..."
                    className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const val = e.currentTarget.value.trim();
                        if (val && !draft.services?.includes(val)) {
                          setDraft((prev) => ({
                            ...prev,
                            services: [...(prev.services || []), val],
                          }));
                          e.currentTarget.value = "";
                        }
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-800"
                    onClick={(e) => {
                      const input = e.currentTarget.previousElementSibling as HTMLInputElement;
                      const val = input.value.trim();
                      if (val && !draft.services?.includes(val)) {
                        setDraft((prev) => ({
                          ...prev,
                          services: [...(prev.services || []), val],
                        }));
                        input.value = "";
                      }
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Last edited
              </label>
              <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-900">
                {formatLastEdited(selected.last_edited_at)}
              </p>
            </div>

            {saveError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {saveError}
              </p>
            )}
          </div>

          <div className="flex gap-3 border-t border-zinc-200 px-6 py-4">
            {isDirty ? (
              <>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || deleting}
                  className="flex-1 rounded-lg bg-green-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(selected);
                    setSaveError(null);
                  }}
                  disabled={saving || deleting}
                  className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Discard
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving || deleting}
                className="w-full rounded-lg border border-red-300 px-4 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete parcel"}
              </button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
