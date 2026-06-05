"use server";

import { createClient } from "@supabase/supabase-js";
import { calculateNextWorkingDay } from "@/lib/properties";
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
    "id, cadastre_number, street_name, house_number, area_sqm, geom, client_id, mowing_price, is_archived, last_edited_at, status, services, mowing_frequency, last_mowed, first_scheduled_date, service_type";

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabaseAdmin
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

const cleanState = (state: any) => {
  if (!state) return null;
  const { geom, ...rest } = state;
  return rest;
};

export async function updatePropertyAction(
  id: string,
  payload: Partial<Omit<PropertyRow, "id" | "geom">>
): Promise<{ error: string | null }> {
  try {
    const { data: previous, error: fetchError } = await supabaseAdmin
      .from("properties")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError || !previous) {
      return { error: fetchError?.message || "Property not found" };
    }

    const { error: updateError } = await supabaseAdmin
      .from("properties")
      .update(payload)
      .eq("id", id);

    if (updateError) {
      return { error: updateError.message };
    }

    const { data: current } = await supabaseAdmin
      .from("properties")
      .select("*")
      .eq("id", id)
      .single();

    if (current) {
      await supabaseAdmin.from("property_audit_logs").insert([
        {
          property_id: id,
          previous_state: cleanState(previous),
          new_state: cleanState(current),
        },
      ]);
    }

    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to update property" };
  }
}

export async function deletePropertyAction(
  id: string
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabaseAdmin
      .from("properties")
      .update({ is_archived: true, last_edited_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      return { error: error.message };
    }
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to delete property" };
  }
}

export async function bulkStatusUpdateAction(
  ids: string[],
  status: string
): Promise<{ error: string | null }> {
  try {
    const normalizedStatus = status.toLowerCase();

    const { data: previousRows, error: fetchErr } = await supabaseAdmin
      .from("properties")
      .select("*")
      .in("id", ids);

    if (fetchErr || !previousRows) {
      return { error: fetchErr?.message || "Failed to fetch properties for bulk update" };
    }

    const { error: updateError } = await supabaseAdmin
      .from("properties")
      .update({ status: normalizedStatus })
      .in("id", ids);

    if (updateError) {
      return { error: updateError.message };
    }

    const { data: newRows } = await supabaseAdmin
      .from("properties")
      .select("*")
      .in("id", ids);

    if (newRows) {
      const logs = previousRows.map((prev) => {
        const current = newRows.find((n) => n.id === prev.id);
        return {
          property_id: prev.id,
          previous_state: cleanState(prev),
          new_state: cleanState(current),
        };
      });

      await supabaseAdmin.from("property_audit_logs").insert(logs);
    }

    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to bulk update status" };
  }
}

export async function bulkDeleteAction(
  ids: string[]
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabaseAdmin
      .from("properties")
      .update({ is_archived: true, last_edited_at: new Date().toISOString() })
      .in("id", ids);

    if (error) {
      return { error: error.message };
    }
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to bulk delete properties" };
  }
}

export async function undoDeletePropertyAction(
  ids: string[]
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabaseAdmin
      .from("properties")
      .update({ is_archived: false, last_edited_at: new Date().toISOString() })
      .in("id", ids);

    if (error) {
      return { error: error.message };
    }
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to undo deletion" };
  }
}

export async function undoPropertyEditsAction(
  propertyIds: string[]
): Promise<{ error: string | null }> {
  try {
    for (const propertyId of propertyIds) {
      const { data: latestLog, error: logError } = await supabaseAdmin
        .from("property_audit_logs")
        .select("*")
        .eq("property_id", propertyId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!logError && latestLog && latestLog.previous_state) {
        const { id: _, geom: __, ...revertPayload } = latestLog.previous_state as any;

        const { error: revertError } = await supabaseAdmin
          .from("properties")
          .update(revertPayload)
          .eq("id", propertyId);

        if (!revertError) {
          await supabaseAdmin
            .from("property_audit_logs")
            .delete()
            .eq("id", latestLog.id);
        }
      }
    }
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to undo edits" };
  }
}

export async function generateUpcomingSchedulesAction(): Promise<{ count: number; error: string | null }> {
  try {
    const { data: props, error: pErr } = await supabaseAdmin
      .from("properties")
      .select("id, status, mowing_frequency, last_mowed, mowing_price, client_id, service_type")
      .eq("status", "active")
      .eq("service_type", "recurring")
      .eq("is_archived", false);

    if (pErr) return { count: 0, error: pErr.message };
    if (!props || props.length === 0) return { count: 0, error: null };

    let createdCount = 0;

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

        let lastMowedDate = new Date();
        if (p.last_mowed) {
          const parts = p.last_mowed.split("-").map(Number);
          if (parts.length === 3 && !parts.some(isNaN)) {
            lastMowedDate = new Date(parts[0], parts[1] - 1, parts[2]);
          } else {
            lastMowedDate = new Date(p.last_mowed);
          }
        }
        if (!isNaN(lastMowedDate.getTime())) {
          lastMowedDate.setDate(lastMowedDate.getDate() + daysToAdd);
          const workingNextDate = calculateNextWorkingDay(lastMowedDate);
          const nextDateStr = `${workingNextDate.getFullYear()}-${String(workingNextDate.getMonth() + 1).padStart(2, '0')}-${String(workingNextDate.getDate()).padStart(2, '0')}`;

          const { error: insertErr } = await supabaseAdmin.from("bookings").insert([
            {
              property_id: p.id,
              client_id: p.client_id,
              scheduled_date: nextDateStr,
              status: "scheduled",
              actual_price: p.mowing_price || null,
              notes: "Auto-scheduled via dispatcher tool.",
            },
          ]);

          if (!insertErr) {
            createdCount++;
          }
        }
      }
    }

    return { count: createdCount, error: null };
  } catch (err) {
    return { count: 0, error: err instanceof Error ? err.message : "Failed to generate schedules" };
  }
}

export async function searchPropertiesAction(
  query: string
): Promise<{ rows: PropertyRow[]; error: string | null }> {
  try {
    const SELECT_COLUMNS =
      "id, cadastre_number, street_name, house_number, area_sqm, geom, client_id, mowing_price, is_archived, last_edited_at, status, services, mowing_frequency, last_mowed, first_scheduled_date, service_type";

    const { data, error } = await supabaseAdmin
      .from("properties")
      .select(SELECT_COLUMNS)
      .eq("is_archived", false)
      .textSearch("search_terms", query, { type: "websearch", config: "simple" })
      .limit(8);

    if (error) {
      return { rows: [], error: error.message };
    }

    return { rows: (data ?? []) as PropertyRow[], error: null };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : "Failed to search properties" };
  }
}
