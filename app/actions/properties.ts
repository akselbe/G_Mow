"use server";

import { createClient } from "@supabase/supabase-js";
import type { PropertyRow, ProfileRow } from "@/lib/properties";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRole || supabaseAnonKey
);

export async function fetchAllPropertiesAction(): Promise<{
  rows: PropertyRow[];
  error: string | null;
}> {
  const allRows: PropertyRow[] = [];
  let from = 0;
  const PAGE_SIZE = 1000;
  const SELECT_COLUMNS =
    "id, cadastre_number, street_name, house_number, area_sqm, geom, client_id, mowing_price, is_archived, last_edited_at, status, services";

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabaseAdmin
      .from("properties")
      .select(SELECT_COLUMNS)
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

export async function fetchAllProfilesAction(): Promise<{
  profiles: ProfileRow[];
  error: string | null;
}> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, first_name, last_name, phone_number")
    .order("first_name", { ascending: true });

  if (error) {
    return { profiles: [], error: error.message };
  }

  return { profiles: (data ?? []) as ProfileRow[], error: null };
}

export async function updatePropertyAction(
  id: string,
  payload: Partial<Omit<PropertyRow, "id" | "geom">>
): Promise<{ error: string | null }> {
  const adjustedPayload = { ...payload };
  if (adjustedPayload.status) {
    adjustedPayload.status =
      adjustedPayload.status.charAt(0).toUpperCase() +
      adjustedPayload.status.slice(1);
  }

  const { error } = await supabaseAdmin
    .from("properties")
    .update(adjustedPayload)
    .eq("id", id);

  if (error) {
    return { error: error.message };
  }
  return { error: null };
}

export async function deletePropertyAction(
  id: string
): Promise<{ error: string | null }> {
  const { error } = await supabaseAdmin
    .from("properties")
    .delete()
    .eq("id", id);

  if (error) {
    return { error: error.message };
  }
  return { error: null };
}

export async function bulkStatusUpdateAction(
  ids: string[],
  status: string
): Promise<{ error: string | null }> {
  const capitalizedStatus =
    status.charAt(0).toUpperCase() + status.slice(1);

  const { error } = await supabaseAdmin
    .from("properties")
    .update({ status: capitalizedStatus })
    .in("id", ids);

  if (error) {
    return { error: error.message };
  }
  return { error: null };
}

export async function bulkDeleteAction(
  ids: string[]
): Promise<{ error: string | null }> {
  const { error } = await supabaseAdmin
    .from("properties")
    .delete()
    .in("id", ids);

  if (error) {
    return { error: error.message };
  }
  return { error: null };
}

export async function syncPropertiesToSnapshotAction(
  target: PropertyRow[],
  current: PropertyRow[]
): Promise<{ error: string | null }> {
  const targetMap = new Map(target.map((row) => [row.id, row]));
  const currentMap = new Map(current.map((row) => [row.id, row]));

  const toInsert = target.filter((row) => !currentMap.has(row.id));
  const toDelete = current.filter((row) => !targetMap.has(row.id));
  const toUpdate = target.filter((row) => {
    const cur = currentMap.get(row.id);
    if (cur === undefined) return false;

    const rowPay = (r: PropertyRow) => ({
      cadastre_number: r.cadastre_number,
      street_name: r.street_name,
      house_number: r.house_number,
      area_sqm: r.area_sqm,
      geom: r.geom,
      client_id: r.client_id,
      mowing_price: r.mowing_price,
      is_archived: r.is_archived,
      last_edited_at: r.last_edited_at,
      status: r.status,
      services: r.services,
    });

    return JSON.stringify(rowPay(row)) !== JSON.stringify(rowPay(cur));
  });

  if (toDelete.length > 0) {
    const { error } = await supabaseAdmin
      .from("properties")
      .delete()
      .in(
        "id",
        toDelete.map((row) => row.id)
      );
    if (error) return { error: error.message };
  }

  const rowPayload = (row: PropertyRow) => ({
    cadastre_number: row.cadastre_number,
    street_name: row.street_name,
    house_number: row.house_number,
    area_sqm: row.area_sqm,
    geom: row.geom,
    client_id: row.client_id,
    mowing_price: row.mowing_price,
    is_archived: row.is_archived,
    last_edited_at: row.last_edited_at,
    status: row.status
      ? row.status.charAt(0).toUpperCase() + row.status.slice(1)
      : null,
    services: row.services,
  });

  if (toInsert.length > 0) {
    const { error } = await supabaseAdmin
      .from("properties")
      .insert(toInsert.map((row) => ({ id: row.id, ...rowPayload(row) })));
    if (error) return { error: error.message };
  }

  for (const row of toUpdate) {
    const { error } = await supabaseAdmin
      .from("properties")
      .update(rowPayload(row))
      .eq("id", row.id);
    if (error) return { error: error.message };
  }

  return { error: null };
}
