export type GeoJsonGeometry = {
  type: string;
  coordinates: unknown;
};

export type GeoJsonFeature = {
  type: "Feature";
  id?: string;
  geometry: GeoJsonGeometry;
  properties: Record<string, unknown>;
};

export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

export type PropertyRow = {
  id: string;
  cadastre_number: string | null;
  street_name: string | null;
  house_number: string | null;
  area_sqm: number | null;
  geom: unknown;
  client_id: string | null;
  mowing_price: number | null;
  is_archived: boolean;
  last_edited_at: string | null;
  status: string | null;
  services: string[] | null;
};

export type PropertyDetails = Omit<PropertyRow, "geom">;

export type ProfileRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
};

export function formatAddress(
  street_name: string | null | undefined,
  house_number: string | null | undefined
): string {
  const street = street_name?.trim() ?? "";
  const house = house_number?.trim() ?? "";
  if (street && house) return `${street} ${house}`;
  return street || house || "";
}

export function formatLastEdited(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export const PROPERTY_STATUSES = [
  "new",
  "contacted",
  "active",
  "completed",
  "archived",
] as const;

export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/** Map fill / outline colors per status (MapLibre `#rrggbb`). */
export const STATUS_MAP_COLORS: Record<
  PropertyStatus,
  { fill: string; outline: string }
> = {
  new: { fill: "#e4e4e7", outline: "#a1a1aa" }, // Light gray
  contacted: { fill: "#60a5fa", outline: "#1d4ed8" }, // Blue
  active: { fill: "#22c55e", outline: "#14532d" }, // Green
  completed: { fill: "#c084fc", outline: "#7e22ce" }, // Purple
  archived: { fill: "#52525b", outline: "#27272a" }, // Dark gray
};

export const DEFAULT_STATUS_MAP_COLORS = {
  fill: "#86efac",
  outline: "#166534",
} as const;

/** MapLibre `match` expression on feature `status` for fill or outline color. */
export function statusColorMatchExpression(
  channel: keyof (typeof STATUS_MAP_COLORS)[PropertyStatus]
): unknown[] {
  const pairs: unknown[] = [];
  for (const status of PROPERTY_STATUSES) {
    pairs.push(status, STATUS_MAP_COLORS[status][channel]);
  }
  pairs.push(DEFAULT_STATUS_MAP_COLORS[channel]);
  return ["match", ["get", "status"], ...pairs];
}

export function parseGeometry(geom: unknown): GeoJsonGeometry | null {
  if (!geom) return null;

  if (typeof geom === "string") {
    try {
      const parsed = JSON.parse(geom) as GeoJsonGeometry;
      if (parsed.type && "coordinates" in parsed) return parsed;
    } catch {
      return null;
    }
  }

  if (typeof geom === "object" && geom !== null) {
    const g = geom as Record<string, unknown>;
    if (g.type === "Feature" && g.geometry) {
      return g.geometry as GeoJsonGeometry;
    }
    if (g.type && g.coordinates) {
      return geom as GeoJsonGeometry;
    }
  }

  return null;
}

export function rowsToFeatureCollection(
  rows: PropertyRow[]
): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [];

  for (const row of rows) {
    const geometry = parseGeometry(row.geom);
    if (!geometry) continue;

    features.push({
      type: "Feature",
      id: row.id,
      geometry,
      properties: {
        id: row.id,
        cadastre_number: row.cadastre_number,
        street_name: row.street_name,
        house_number: row.house_number,
        area_sqm: row.area_sqm,
        client_id: row.client_id,
        mowing_price: row.mowing_price,
        is_archived: row.is_archived,
        last_edited_at: row.last_edited_at,
        status: row.status,
        services: row.services,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

/**
 * Calculates the mowing price based on the 40 EUR / 676 sqm benchmark.
 * @param areaSqm - The area of the property in square meters
 * @param includesTrimming - Whether weed whacking is included
 * @param includesBorders - Whether outside ditch/street borders are included
 * @returns The final price rounded to the nearest Euro
 */
export function calculateMowingPrice(
  areaSqm: number,
  includesTrimming: boolean = true,
  includesBorders: boolean = true
): number {
  if (areaSqm <= 0) return 0;

  // €10 base price
  const basePrice = 10;

  // 80% effective area (since gardens/drives/etc. are not mowable)
  const effectiveArea = areaSqm * 0.8;

  // We use a square-root scaling model to level out the cost per m2.
  // This achieves the target prices of €40 for 700 sqm and €60 for 2000 sqm
  // when all services (mowing, trimming, outside) are selected.
  const servicesBaseFactor = Math.sqrt(effectiveArea);

  // Mowing represents 80% of the service base rate
  const mowingPrice = servicesBaseFactor * 0.912; // 1.14 * 0.8

  let servicesPrice = mowingPrice;

  // Trimming represents 20% of the service base rate
  if (includesTrimming) {
    const trimmingPrice = servicesBaseFactor * 0.228; // 1.14 * 0.2
    servicesPrice += trimmingPrice;
  }

  // If outside ditch/street borders is selected, combined service price is multiplied by 1.1
  if (includesBorders) {
    servicesPrice *= 1.1;
  }

  const finalPrice = basePrice + servicesPrice;

  // Round to the nearest whole Euro for clean CRM billing
  return Math.round(finalPrice);
}
