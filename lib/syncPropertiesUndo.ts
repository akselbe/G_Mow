import type { SupabaseClient } from "@supabase/supabase-js";

import type { PropertyRow } from "@/lib/properties";

function rowPayload(row: PropertyRow) {
  return {
    cadastre_number: row.cadastre_number,
    street_name: row.street_name,
    house_number: row.house_number,
    area_sqm: row.area_sqm,
    geom: row.geom,
    client_id: row.client_id,
    mowing_price: row.mowing_price,
    is_archived: row.is_archived,
    last_edited_at: row.last_edited_at,
    status: row.status,
    services: row.services,
  };
}

function rowsEqual(a: PropertyRow, b: PropertyRow): boolean {
  return JSON.stringify(rowPayload(a)) === JSON.stringify(rowPayload(b));
}

/** Reconcile Supabase `properties` table with a prior snapshot (single-step undo). */
export async function syncPropertiesToSnapshot(
  supabase: SupabaseClient,
  target: PropertyRow[],
  current: PropertyRow[]
): Promise<{ error: string | null }> {
  const targetMap = new Map(target.map((row) => [row.id, row]));
  const currentMap = new Map(current.map((row) => [row.id, row]));

  const toInsert = target.filter((row) => !currentMap.has(row.id));
  const toDelete = current.filter((row) => !targetMap.has(row.id));
  const toUpdate = target.filter((row) => {
    const cur = currentMap.get(row.id);
    return cur !== undefined && !rowsEqual(row, cur);
  });

  if (toDelete.length > 0) {
    const { error } = await supabase
      .from("properties")
      .delete()
      .in(
        "id",
        toDelete.map((row) => row.id)
      );
    if (error) return { error: error.message };
  }

  if (toInsert.length > 0) {
    const { error } = await supabase
      .from("properties")
      .insert(toInsert.map((row) => ({ id: row.id, ...rowPayload(row) })));
    if (error) return { error: error.message };
  }

  for (const row of toUpdate) {
    const { error } = await supabase
      .from("properties")
      .update(rowPayload(row))
      .eq("id", row.id);
    if (error) return { error: error.message };
  }

  return { error: null };
}

export function clonePropertyRows(rows: PropertyRow[]): PropertyRow[] {
  return JSON.parse(JSON.stringify(rows)) as PropertyRow[];
}
