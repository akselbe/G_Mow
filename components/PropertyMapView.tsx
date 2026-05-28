"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map } from "maplibre-gl";

import { fetchAllProperties } from "@/lib/fetchAllProperties";
import { supabase } from "@/lib/supabase";
import {
  rowsToFeatureCollection,
  type GeoJsonFeatureCollection,
  type PropertyDetails,
  type PropertyRow,
} from "@/lib/properties";

const GARUPE_CENTER: [number, number] = [24.19, 57.11];
const INITIAL_ZOOM = 14.5;
const SOURCE_ID = "properties";
const FILL_LAYER_ID = "properties-fill";
const OUTLINE_LAYER_ID = "properties-outline";
const INTERACTIVE_LAYERS = [FILL_LAYER_ID, OUTLINE_LAYER_ID];

const emptyDetails = (): PropertyDetails => ({
  id: "",
  client_name: null,
  phone: null,
  mowing_price: null,
  status: null,
});

export default function PropertyMapView() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const hoveredIdRef = useRef<string | number | null>(null);
  const selectedIdRef = useRef<string | number | null>(null);
  const geojsonRef = useRef<GeoJsonFeatureCollection | null>(null);

  const [properties, setProperties] = useState<PropertyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [panelOpen, setPanelOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PropertyDetails | null>(null);
  const [draft, setDraft] = useState<PropertyDetails>(emptyDetails());

  const syncMapData = useCallback((collection: GeoJsonFeatureCollection) => {
    geojsonRef.current = collection;
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;

    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData(collection as unknown as GeoJSON.FeatureCollection);
    }
  }, []);

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
          "fill-color": "#22c55e",
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.6,
            ["boolean", ["feature-state", "hover"], false],
            0.55,
            0.35,
          ],
        },
      });

      map.addLayer({
        id: OUTLINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": "#14532d",
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
        if (!features.length) return;

        const props = features[0].properties as Record<string, unknown> | null;
        if (!props?.id) return;

        const details: PropertyDetails = {
          id: String(props.id),
          client_name: (props.client_name as string | null) ?? null,
          phone: (props.phone as string | null) ?? null,
          mowing_price:
            props.mowing_price === null || props.mowing_price === undefined
              ? null
              : Number(props.mowing_price),
          status: (props.status as string | null) ?? null,
        };

        setSelected(details);
        setDraft(details);
        setEditing(false);
        setSaveError(null);
        setPanelOpen(true);

        if (selectedIdRef.current !== null) {
          map.removeFeatureState({
            source: SOURCE_ID,
            id: selectedIdRef.current,
          });
        }
        selectedIdRef.current = details.id;
        map.setFeatureState(
          { source: SOURCE_ID, id: details.id },
          { selected: true }
        );
      });

      setMapReady(true);
    });

    return () => {
      window.removeEventListener("resize", onResize);
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  const closePanel = () => {
    const map = mapRef.current;
    if (map && selectedIdRef.current !== null) {
      map.removeFeatureState({ source: SOURCE_ID, id: selectedIdRef.current });
      selectedIdRef.current = null;
    }
    setPanelOpen(false);
    setEditing(false);
    setSaveError(null);
    setSelected(null);
  };

  const handleSave = async () => {
    if (!selected) return;

    setSaving(true);
    setSaveError(null);

    const payload = {
      client_name: draft.client_name?.trim() || null,
      phone: draft.phone?.trim() || null,
      mowing_price:
        draft.mowing_price === null || draft.mowing_price === undefined
          ? null
          : Number(draft.mowing_price),
      status: draft.status?.trim() || null,
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

    const updatedRows = properties.map((row) =>
      row.id === selected.id ? { ...row, ...payload } : row
    );
    setProperties(updatedRows);
    syncMapData(rowsToFeatureCollection(updatedRows));

    const saved: PropertyDetails = { id: selected.id, ...payload };
    setSelected(saved);
    setDraft(saved);
    setEditing(false);
    setSaving(false);
  };

  const displayValue = (value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === "") {
      return "—";
    }
    return String(value);
  };

  const parcelCount = rowsToFeatureCollection(properties).features.length;

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

      <div className="absolute left-4 top-4 z-10 max-w-sm rounded-lg bg-white/95 px-4 py-2 text-sm shadow-md ring-1 ring-zinc-200">
        <p className="font-medium text-zinc-900">Garupe Mow</p>
        {loading && <p className="text-zinc-600">Loading properties…</p>}
        {!loading && !fetchError && (
          <p className="text-zinc-600">
            {parcelCount > 0
              ? `${parcelCount} parcels on map`
              : "No parcels to display"}
          </p>
        )}
        {fetchError && (
          <p className="text-red-600">Failed to load: {fetchError}</p>
        )}
        {mapError && <p className="text-red-600">Map error: {mapError}</p>}
      </div>

      {panelOpen && selected && (
        <aside className="absolute right-0 top-0 z-20 flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">Property</h2>
              <p className="text-xs text-zinc-500">ID: {selected.id}</p>
            </div>
            <button
              type="button"
              onClick={closePanel}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
            >
              Close
            </button>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            {(
              [
                ["client_name", "Client name", "text"],
                ["phone", "Phone", "tel"],
                ["mowing_price", "Mowing price (€)", "number"],
                ["status", "Status", "text"],
              ] as const
            ).map(([key, label, inputType]) => (
              <div key={key}>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                  {label}
                </label>
                {editing ? (
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
                        [key]:
                          key === "mowing_price"
                            ? raw === ""
                              ? null
                              : Number(raw)
                            : raw || null,
                      }));
                    }}
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
                  />
                ) : (
                  <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-900">
                    {key === "mowing_price"
                      ? selected.mowing_price !== null &&
                        selected.mowing_price !== undefined
                        ? `€${selected.mowing_price}`
                        : "—"
                      : displayValue(selected[key])}
                  </p>
                )}
              </div>
            ))}

            {saveError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {saveError}
              </p>
            )}
          </div>

          <div className="flex gap-3 border-t border-zinc-200 px-6 py-4">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 rounded-lg bg-green-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(selected);
                    setEditing(false);
                    setSaveError(null);
                  }}
                  disabled={saving}
                  className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="flex-1 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800"
              >
                Edit
              </button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
