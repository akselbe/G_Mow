"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map,
} from "maplibre-gl";

import {
  PROPERTY_STATUSES,
  STATUS_MAP_COLORS,
  STATUS_DISPLAY_LABELS,
  calculateMowingPrice,
  formatAddress,
  formatLastEdited,
  parseGeometry,
  rowsToFeatureCollection,
  statusColorMatchExpression,
  type GeoJsonFeatureCollection,
  type PropertyDetails,
  type PropertyRow,
  type ProfileRow,
  type PropertyStatus,
} from "@/lib/properties";
import {
  fetchAllPropertiesAction,
  fetchAllProfilesAction,
  updatePropertyAction,
  deletePropertyAction,
  bulkStatusUpdateAction,
  bulkDeleteAction,
  undoDeletePropertyAction,
  undoPropertyEditsAction,
  searchPropertiesAction,
} from "@/app/actions/properties";

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
  client_id: null,
  mowing_price: null,
  is_archived: false,
  last_edited_at: null,
  status: null,
  services: [],
  mowing_frequency: null,
  last_mowed: null,
  first_scheduled_date: null,
  service_type: "on-demand",
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
    client_id: parseOptionalString(props.client_id),
    mowing_price: parseOptionalNumber(props.mowing_price),
    is_archived: props.is_archived === true,
    last_edited_at: parseOptionalString(props.last_edited_at),
    status: parseOptionalString(props.status)?.toLowerCase() || null,
    services: parsedServices,
    mowing_frequency: parseOptionalString(props.mowing_frequency),
    last_mowed: parseOptionalString(props.last_mowed),
    first_scheduled_date: parseOptionalString(props.first_scheduled_date),
    service_type: (parseOptionalString(props.service_type) as "recurring" | "on-demand") || "on-demand",
  };
}

function detailsFromRow(row: PropertyRow): PropertyDetails {
  const { geom: _geom, ...details } = row;
  return details;
}

function isMultiSelectKey(e: MouseEvent | PointerEvent): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey;
}

type UndoAction = {
  type: "edit" | "delete";
  propertyIds: string[];
  label: string;
};

export default function PropertyMapView({ onViewCalendar }: { onViewCalendar?: () => void } = {}) {
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
  const servicesInputRef = useRef<HTMLInputElement>(null);
  const [servicesInputValue, setServicesInputValue] = useState("");
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [searchResults, setSearchResults] = useState<PropertyRow[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [bulkStatus, setBulkStatus] = useState<string>("active");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

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

  const handleUndo = useCallback(async () => {
    if (!undoAction) return;

    setUndoing(true);
    setUndoError(null);

    let res: { error: string | null };
    if (undoAction.type === "delete") {
      res = await undoDeletePropertyAction(undoAction.propertyIds);
    } else {
      res = await undoPropertyEditsAction(undoAction.propertyIds);
    }

    if (res.error) {
      setUndoError(res.error);
      setUndoing(false);
      return;
    }

    const updatedRows = await loadProperties();
    applyMapSelection(undoAction.propertyIds);
    setSelectedIds(undoAction.propertyIds);

    if (undoAction.propertyIds.length === 1 && updatedRows) {
      const row = updatedRows.find((r) => r.id === undoAction.propertyIds[0]);
      if (row) {
        setSelected(detailsFromRow(row));
        setDraft(detailsFromRow(row));
        setPanelOpen(true);
      }
    } else {
      setPanelOpen(false);
      setSelected(null);
    }

    setUndoAction(null);
    setUndoing(false);
  }, [undoAction, applyMapSelection]);

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

    const [propertiesRes, profilesRes] = await Promise.all([
      fetchAllPropertiesAction(),
      fetchAllProfilesAction(),
    ]);

    if (propertiesRes.error) {
      setFetchError(propertiesRes.error);
      setLoading(false);
      return;
    }

    if (profilesRes.error) {
      setFetchError(profilesRes.error);
      setLoading(false);
      return;
    }

    // Normalize property statuses to lowercase to ensure map color matching and select options matching
    const normalizedRows = propertiesRes.rows.map((row) => ({
      ...row,
      status: row.status ? row.status.toLowerCase() : null,
    }));

    setProfiles(profilesRes.profiles);
    setProperties(normalizedRows);
    syncMapData(rowsToFeatureCollection(normalizedRows));
    setLoading(false);
    return normalizedRows;
  }, [syncMapData]);

  const zoomToProperty = useCallback((property: PropertyRow) => {
    const map = mapRef.current;
    if (!map) return;
    const geom = parseGeometry(property.geom);
    if (!geom) return;

    let center: [number, number] | null = null;
    if (geom.type === "Polygon") {
      const coords = (geom.coordinates as any)[0];
      if (coords && coords.length > 0) {
        let sumX = 0, sumY = 0;
        coords.forEach(([x, y]: any) => { sumX += x; sumY += y; });
        center = [sumX / coords.length, sumY / coords.length];
      }
    } else if (geom.type === "MultiPolygon") {
      const coords = (geom.coordinates as any)[0][0];
      if (coords && coords.length > 0) {
        let sumX = 0, sumY = 0;
        coords.forEach(([x, y]: any) => { sumX += x; sumY += y; });
        center = [sumX / coords.length, sumY / coords.length];
      }
    } else if (geom.type === "Point") {
      center = geom.coordinates as [number, number];
    }

    if (center) {
      map.flyTo({
        center,
        zoom: 17,
        essential: true,
      });

      updateSelection([property.id], detailsFromRow(property));
      setPanelOpen(true);
    }
  }, [updateSelection]);

  // Clean search input: lowercase and remove "iela", "ceļš", "līnija", "gatve"
  const sanitizeSearchInput = (input: string): string => {
    const noiseWords = new Set(["iela", "ceļš", "līnija", "gatve"]);
    return input
      .toLowerCase()
      .split(/\s+/)
      .filter(word => !noiseWords.has(word))
      .join(" ")
      .trim();
  };

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true);
      const sanitized = sanitizeSearchInput(query);
      if (!sanitized) {
        setSearchResults([]);
        setSearchLoading(false);
        return;
      }

      const { rows, error } = await searchPropertiesAction(sanitized);
      if (!error && rows) {
        const normalized = rows.map((row) => ({
          ...row,
          status: row.status ? row.status.toLowerCase() : null,
        }));
        setSearchResults(normalized);
      } else {
        setSearchResults([]);
      }
      setSearchLoading(false);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

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

    const normalizedStatus = draft.status?.trim().toLowerCase() || null;
    
    if (normalizedStatus === "active") {
      if (!draft.client_id) {
        setSaveError("An 'Active' property must have a Client assigned.");
        setSaving(false);
        return;
      }
      if (!draft.last_mowed && !draft.first_scheduled_date) {
        setSaveError("An 'Active' property requires either a 'Last Mowed' date or a 'First Scheduled' date.");
        setSaving(false);
        return;
      }
    }

    const payload = {
      client_id: draft.client_id || null,
      mowing_price:
        draft.mowing_price === null || draft.mowing_price === undefined
          ? null
          : Number(draft.mowing_price),
      status: draft.status?.trim() || null,
      services: draft.services || [],
      mowing_frequency: draft.service_type === "on-demand" ? null : (draft.mowing_frequency || "bi-weekly"),
      last_mowed: draft.last_mowed || null,
      first_scheduled_date: draft.first_scheduled_date || null,
      service_type: draft.service_type || "on-demand",
      last_edited_at: new Date().toISOString(),
    };

    const { error } = await updatePropertyAction(selected.id, payload);

    if (error) {
      setSaveError(error);
      setSaving(false);
      return;
    }

    setUndoAction({
      type: "edit",
      propertyIds: [selected.id],
      label: "Saved property",
    });

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

    const { error } = await deletePropertyAction(selected.id);

    if (error) {
      setSaveError(error);
      setDeleting(false);
      return;
    }

    setUndoAction({
      type: "delete",
      propertyIds: [selected.id],
      label: "Deleted property",
    });

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

    const status = bulkStatus.trim() || "uncontacted";
    
    if (status.toLowerCase() === "active") {
      const idSet = new Set(selectedIds);
      const invalidRows = properties.filter((r) => {
        if (!idSet.has(r.id)) return false;
        
        const hasClient = !!r.client_id;
        const hasDate = !!r.last_mowed || !!r.first_scheduled_date;
        const hasFreqIfRecurring = r.service_type !== "on-demand" ? !!r.mowing_frequency : true;
        
        return !hasClient || !hasDate || !hasFreqIfRecurring;
      });

      if (invalidRows.length > 0) {
        setBulkError(`Cannot set ${invalidRows.length} properties to 'Active' because they are missing a Client, a scheduling date ('Last Mowed' or 'First Scheduled'), or a Mowing Frequency (for recurring properties).`);
        setBulkSaving(false);
        return;
      }
    }

    const { error } = await bulkStatusUpdateAction(selectedIds, status);

    if (error) {
      setBulkError(error);
      setBulkSaving(false);
      return;
    }

    setUndoAction({
      type: "edit",
      propertyIds: [...selectedIds],
      label: `Updated status on ${selectedIds.length} parcels`,
    });

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

    const { error } = await bulkDeleteAction(selectedIds);

    if (error) {
      setBulkError(error);
      setBulkDeleting(false);
      return;
    }

    setUndoAction({
      type: "delete",
      propertyIds: [...selectedIds],
      label: `Deleted ${selectedIds.length} parcels`,
    });

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
    draft.client_id !== selected.client_id ||
    draft.mowing_price !== selected.mowing_price ||
    draft.status !== selected.status ||
    draft.mowing_frequency !== selected.mowing_frequency ||
    draft.last_mowed !== selected.last_mowed ||
    draft.first_scheduled_date !== selected.first_scheduled_date ||
    draft.service_type !== selected.service_type ||
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

      {undoAction && (
        <div className="absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoing || saving || deleting || bulkBusy}
            className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {undoing ? "Undoing…" : `Undo: ${undoAction.label}`}
          </button>
          {undoError && (
            <p className="max-w-xs rounded-lg bg-red-50 px-3 py-2 text-center text-xs text-red-700 shadow">
              {undoError}
            </p>
          )}
        </div>
      )}



      {/* Top Center Navigation Bar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center">
        <div className="flex items-center gap-1.5 rounded-full bg-white/95 px-2 py-1.5 shadow-lg ring-1 ring-zinc-200/80 backdrop-blur-md">
          {/* Map Button */}
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider bg-green-700 text-white shadow-sm transition-all duration-200"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
              />
            </svg>
            <span>Map</span>
          </button>

          {/* Calendar Button */}
          <button
            type="button"
            onClick={onViewCalendar}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-600 transition-all duration-200"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <span>Calendar</span>
          </button>

          {/* Separator */}
          <div className="h-4 w-[1px] bg-zinc-200" />

          {/* Search Section */}
          <div className="relative">
            {searchExpanded ? (
              <div className="flex w-64 items-center gap-1.5 rounded-full bg-zinc-50 border border-zinc-200/80 px-2.5 py-0.5 shadow-inner focus-within:ring-2 focus-within:ring-green-500/20 focus-within:border-green-600 transition-all duration-300">
                <svg
                  className="h-3.5 w-3.5 text-zinc-400 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  type="text"
                  placeholder="Search address or cadastre..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-transparent p-0 text-xs text-zinc-900 outline-none border-0 focus:ring-0 focus:outline-none"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults([]);
                    setSearchExpanded(false);
                  }}
                  className="text-zinc-400 hover:text-zinc-600 focus:outline-none shrink-0"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSearchExpanded(true)}
                className="flex items-center justify-center rounded-full p-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-all duration-200"
                title="Search properties"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </button>
            )}

            {searchExpanded && searchResults.length > 0 && (
              <ul className="absolute right-0 mt-2 max-h-60 w-80 overflow-y-auto rounded-lg border border-zinc-200 bg-white/95 py-1.5 shadow-xl backdrop-blur-sm z-50">
                {searchResults.map((p) => {
                  const addr = formatAddress(p.street_name, p.house_number) || "Unknown Address";
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          zoomToProperty(p);
                          setSearchQuery("");
                          setSearchResults([]);
                          setSearchExpanded(false);
                        }}
                        className="w-full px-4 py-2.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 flex flex-col gap-0.5"
                      >
                        <span className="font-semibold">{addr}</span>
                        {p.cadastre_number && (
                          <span className="text-[10px] text-zinc-400">
                            Cadastre: {p.cadastre_number}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {bulkMode && (
        <aside className="absolute right-0 top-0 z-40 flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl">
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
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2 disabled:opacity-60 capitalize"
              >
                {PROPERTY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_DISPLAY_LABELS[status]}
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
        <aside className="absolute right-0 top-0 z-40 flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl">
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

            {/* Client Dropdown */}
            {draft.status !== "uncontacted" && (
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Client
                </label>
                <select
                  value={draft.client_id ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setDraft((prev) => ({
                      ...prev,
                      client_id: val || null,
                    }));
                  }}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
                >
                  <option value="">Unassigned</option>
                  {profiles.map((profile) => {
                    const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
                    const displayLabel = fullName 
                      ? `${fullName}${profile.phone_number ? ` (${profile.phone_number})` : ""}`
                      : profile.phone_number || "Unnamed profile";
                    return (
                      <option key={profile.id} value={profile.id}>
                        {displayLabel}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

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
                {draft.status === "active" && selected.area_sqm !== null && selected.area_sqm !== undefined && (
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
              {draft.status === "active" ? (
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
              ) : (
                <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-900">
                  €{selected.area_sqm ? calculateMowingPrice(selected.area_sqm, draft.services?.includes("trimming") ?? false, draft.services?.includes("outside") ?? false) : "—"} (Estimated Standard Price)
                </p>
              )}
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
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2 capitalize"
              >
                {PROPERTY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_DISPLAY_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>

            {draft.status === "active" && (
              <>
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Service Type
                  </label>
                  <select
                    value={draft.service_type ?? "on-demand"}
                    onChange={(e) => {
                      const val = e.target.value as "recurring" | "on-demand";
                      setDraft((prev) => ({
                        ...prev,
                        service_type: val,
                        mowing_frequency: val === "recurring" ? (prev.mowing_frequency || "bi-weekly") : null,
                      }));
                    }}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
                  >
                    <option value="recurring">Recurring</option>
                    <option value="on-demand">On-Demand</option>
                  </select>
                </div>

                {draft.service_type !== "on-demand" && (
                  <div>
                    <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Mowing Frequency
                    </label>
                    <select
                      value={draft.mowing_frequency ?? "bi-weekly"}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          mowing_frequency: e.target.value || null,
                        }))
                      }
                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2 capitalize"
                    >
                      <option value="weekly">Weekly</option>
                      <option value="bi-weekly">Bi-weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="10">Every 10 Days</option>
                      <option value="21">Every 3 Weeks</option>
                    </select>
                  </div>
                )}

                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Last Mowed Date
                  </label>
                  <input
                    type="date"
                    value={draft.last_mowed ?? ""}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        last_mowed: e.target.value || null,
                      }))
                    }
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    First Scheduled Date
                  </label>
                  <input
                    type="date"
                    value={draft.first_scheduled_date ?? ""}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        first_scheduled_date: e.target.value || null,
                      }))
                    }
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none ring-green-500/30 transition focus:border-green-600 focus:ring-2"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Services
                  </label>
                  <div
                    onClick={() => servicesInputRef.current?.focus()}
                    className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 cursor-text transition-all duration-200 outline-none ring-green-500/30 focus-within:border-green-600 focus-within:ring-2 min-h-[46px]"
                  >
                    {(draft.services || []).map((service) => {
                      const isPredefined = ["mowing", "trimming", "outside"].includes(service);
                      return (
                        <span
                          key={service}
                          className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium select-none transition-colors ${
                            isPredefined
                              ? "bg-green-100 text-green-800 ring-1 ring-green-600/20"
                              : "bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200"
                          }`}
                        >
                          <span className="capitalize">{service}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDraft((prev) => ({
                                ...prev,
                                services: (prev.services || []).filter((s) => s !== service),
                              }));
                            }}
                            className={`ml-0.5 rounded-full p-0.5 w-4 h-4 flex items-center justify-center transition-colors duration-150 ${
                              isPredefined
                                ? "text-green-600 hover:text-green-900 hover:bg-green-200/50"
                                : "text-zinc-400 hover:text-zinc-800 hover:bg-zinc-200"
                            }`}
                          >
                            &times;
                          </button>
                        </span>
                      );
                    })}
                    <input
                      ref={servicesInputRef}
                      type="text"
                      placeholder={(draft.services || []).length === 0 ? "Add services..." : ""}
                      value={servicesInputValue}
                      onChange={(e) => setServicesInputValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const val = servicesInputValue.trim().toLowerCase();
                          if (val && !draft.services?.includes(val)) {
                            setDraft((prev) => ({
                              ...prev,
                              services: [...(prev.services || []), val],
                            }));
                          }
                          setServicesInputValue("");
                        } else if (e.key === "Backspace" && servicesInputValue === "") {
                          const current = draft.services || [];
                          if (current.length > 0) {
                            setDraft((prev) => ({
                              ...prev,
                              services: current.slice(0, -1),
                            }));
                          }
                        }
                      }}
                      className="flex-1 min-w-[80px] bg-transparent text-sm text-zinc-900 outline-none border-0 p-0 focus:outline-none focus:ring-0 focus:border-transparent"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 mr-1">
                      Suggestions:
                    </span>
                    {[
                      "mowing",
                      "trimming",
                      "outside",
                      "gutter cleaning",
                      "weeding",
                      "leaf removal",
                      "pruning",
                      "fertilizing",
                      "planting",
                    ].map((service) => {
                      const isSelected = draft.services?.includes(service) ?? false;
                      return (
                        <button
                          key={service}
                          type="button"
                          onClick={() => {
                            const current = draft.services || [];
                            setDraft((prev) => ({
                              ...prev,
                              services: isSelected
                                ? current.filter((s) => s !== service)
                                : [...current, service],
                            }));
                          }}
                          className={`rounded-full px-2 py-0.5 text-xs font-medium border transition-all duration-150 ${
                            isSelected
                              ? "bg-green-50 text-green-700 border-green-200 ring-1 ring-green-600/10"
                              : "bg-zinc-50 text-zinc-500 border-zinc-200 hover:bg-zinc-100 hover:text-zinc-800"
                          }`}
                        >
                          {isSelected ? "✓ " : "+ "}
                          <span className="capitalize">{service}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

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
