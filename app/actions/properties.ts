"use server";

import { createClient } from "@supabase/supabase-js";
import type { PropertyRow, ProfileRow } from "@/lib/properties";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder";

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
    "id, cadastre_number, street_name, house_number, area_sqm, geom, client_id, mowing_price, is_archived, last_edited_at, status, services, mowing_frequency, last_mowed";

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

  const { error } = await supabaseAdmin
    .from("properties")
    .update(adjustedPayload)
    .eq("id", id);

  if (error) {
    return { error: error.message };
  }
  
  await ensureActivePropertiesScheduled([id]);

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
  const normalizedStatus = status.toLowerCase();

  const { error } = await supabaseAdmin
    .from("properties")
    .update({ status: normalizedStatus })
    .in("id", ids);

  if (error) {
    return { error: error.message };
  }
  
  await ensureActivePropertiesScheduled(ids);

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
      mowing_frequency: r.mowing_frequency,
      last_mowed: r.last_mowed,
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
    status: row.status || null,
    services: row.services,
    mowing_frequency: row.mowing_frequency,
    last_mowed: row.last_mowed,
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

  const allIdsToSync = [...toInsert.map(r => r.id), ...toUpdate.map(r => r.id)];
  await ensureActivePropertiesScheduled(allIdsToSync);

  return { error: null };
}

async function ensureActivePropertiesScheduled(propertyIds: string[]) {
  if (propertyIds.length === 0) return;

  const { data: props, error: pErr } = await supabaseAdmin
    .from("properties")
    .select("id, status, mowing_frequency, last_mowed, mowing_price, client_id")
    .in("id", propertyIds)
    .eq("status", "active");

  if (pErr || !props || props.length === 0) return;

  for (const p of props) {
    if (!p.last_mowed || !p.mowing_frequency) continue;

    const { data: existing, error: bErr } = await supabaseAdmin
      .from("bookings")
      .select("id")
      .eq("property_id", p.id)
      .eq("status", "scheduled")
      .limit(1);

    if (!bErr && (!existing || existing.length === 0)) {
      let daysToAdd = 14;
      const freq = p.mowing_frequency;
      if (freq === "weekly") daysToAdd = 7;
      else if (freq === "bi-weekly") daysToAdd = 14;
      else if (freq === "monthly") daysToAdd = 30;
      else {
        const parsed = parseInt(freq, 10);
        if (!isNaN(parsed) && parsed > 0) daysToAdd = parsed;
      }

      const lastMowedDate = new Date(p.last_mowed);
      if (!isNaN(lastMowedDate.getTime())) {
        lastMowedDate.setDate(lastMowedDate.getDate() + daysToAdd);
        const nextDateStr = `${lastMowedDate.getFullYear()}-${String(lastMowedDate.getMonth() + 1).padStart(2, '0')}-${String(lastMowedDate.getDate()).padStart(2, '0')}`;

        await supabaseAdmin.from("bookings").insert([{
          property_id: p.id,
          client_id: p.client_id,
          scheduled_date: nextDateStr,
          status: "scheduled",
          actual_price: p.mowing_price || null,
          notes: "Auto-scheduled based on last mowed date."
        }]);
      }
    }
  }
}
