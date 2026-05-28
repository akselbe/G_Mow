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
  geom: unknown;
  client_name: string | null;
  phone: string | null;
  mowing_price: number | null;
  status: string | null;
};

export type PropertyDetails = {
  id: string;
  client_name: string | null;
  phone: string | null;
  mowing_price: number | null;
  status: string | null;
};

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
        client_name: row.client_name,
        phone: row.phone,
        mowing_price: row.mowing_price,
        status: row.status,
      },
    });
  }

  return { type: "FeatureCollection", features };
}
