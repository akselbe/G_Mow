import { supabase } from "@/lib/supabase";
import type { PropertyRow } from "@/lib/properties";

const PAGE_SIZE = 1000;
const SELECT_COLUMNS =
  "id, cadastre_number, street_name, house_number, area_sqm, geom, client_id, mowing_price, is_archived, last_edited_at, status, services";

/**
 * PostgREST (Supabase) caps each response at 1000 rows by default.
 * Paginate until every property row is loaded.
 */
export async function fetchAllProperties(): Promise<{
  rows: PropertyRow[];
  error: string | null;
}> {
  const allRows: PropertyRow[] = [];
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await supabase
      .from("properties")
      .select(SELECT_COLUMNS)
      .eq("is_archived", false)
      .range(from, to);

    if (error) {
      return { rows: allRows, error: error.message };
    }

    const batch = (data ?? []) as PropertyRow[];
    allRows.push(...batch);

    if (batch.length < PAGE_SIZE) {
      break;
    }

    from += PAGE_SIZE;
  }

  return { rows: allRows, error: null };
}
