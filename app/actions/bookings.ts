"use server";

import { createClient } from "@supabase/supabase-js";
import type { BookingRow, BookingWithProperty } from "@/lib/properties";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder";

const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRole || supabaseAnonKey
);

/**
 * Fetch all bookings within a date range, joining property and profile details.
 */
export async function fetchBookingsAction(
  startDate: string,
  endDate: string
): Promise<{ bookings: BookingWithProperty[]; error: string | null }> {
  try {
    const { data, error } = await supabaseAdmin
      .from("bookings")
      .select(`
        *,
        properties (
          id,
          cadastre_number,
          street_name,
          house_number,
          area_sqm,
          mowing_price,
          client_id,
          mowing_frequency
        )
      `)
      .gte("scheduled_date", startDate)
      .lte("scheduled_date", endDate)
      .order("scheduled_date", { ascending: true });

    if (error) {
      return { bookings: [], error: error.message };
    }

    return { bookings: (data ?? []) as BookingWithProperty[], error: null };
  } catch (err) {
    return { bookings: [], error: err instanceof Error ? err.message : "Failed to fetch bookings" };
  }
}

/**
 * Create a new booking.
 */
export async function createBookingAction(payload: {
  property_id: string;
  scheduled_date: string;
  status?: string;
  notes?: string;
  actual_price?: number;
}): Promise<{ booking: BookingRow | null; error: string | null }> {
  try {
    const { data: prop } = await supabaseAdmin
      .from("properties")
      .select("client_id")
      .eq("id", payload.property_id)
      .single();

    const insertPayload = {
      ...payload,
      client_id: prop?.client_id || null,
    };

    const { data, error } = await supabaseAdmin
      .from("bookings")
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      return { booking: null, error: error.message };
    }

    return { booking: data as BookingRow, error: null };
  } catch (err) {
    return { booking: null, error: err instanceof Error ? err.message : "Failed to create booking" };
  }
}

/**
 * Update an existing booking.
 */
export async function updateBookingAction(
  id: string,
  payload: Partial<Omit<BookingRow, "id" | "created_at">>
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabaseAdmin
      .from("bookings")
      .update(payload)
      .eq("id", id);

    if (error) {
      return { error: error.message };
    }

    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to update booking" };
  }
}

/**
 * Delete a booking.
 */
export async function deleteBookingAction(
  id: string
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabaseAdmin
      .from("bookings")
      .delete()
      .eq("id", id);

    if (error) {
      return { error: error.message };
    }

    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to delete booking" };
  }
}

/**
 * Mark a booking as completed and auto-schedule the next one based on mowing frequency.
 */
export async function completeBookingAndScheduleNextAction(
  bookingId: string,
  notes: string | null
): Promise<{ error: string | null }> {
  try {
    // 1. Fetch current booking and its property details
    const { data: booking, error: fetchError } = await supabaseAdmin
      .from("bookings")
      .select(`
        *,
        properties (
          id,
          client_id,
          mowing_frequency,
          mowing_price
        )
      `)
      .eq("id", bookingId)
      .single();

    if (fetchError || !booking) {
      return { error: fetchError?.message || "Booking not found" };
    }

    // 2. Mark current booking as completed
    const { error: updateError } = await supabaseAdmin
      .from("bookings")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        notes: notes !== null ? notes : booking.notes
      })
      .eq("id", bookingId);

    if (updateError) {
      return { error: updateError.message };
    }

    // 3. Calculate next schedule date based on mowing_frequency
    const frequency = booking.properties?.mowing_frequency || "bi-weekly";
    let daysToAdd = 14; // Default to bi-weekly

    if (frequency === "weekly") {
      daysToAdd = 7;
    } else if (frequency === "bi-weekly") {
      daysToAdd = 14;
    } else if (frequency === "monthly") {
      daysToAdd = 30;
    } else {
      // If frequency is a number stored as string
      const parsed = parseInt(frequency, 10);
      if (!isNaN(parsed) && parsed > 0) {
        daysToAdd = parsed;
      }
    }

    const currentDate = new Date(booking.scheduled_date);
    const nextDate = new Date(currentDate);
    nextDate.setDate(currentDate.getDate() + daysToAdd);

    // Format as YYYY-MM-DD using local time to avoid timezone offset issues
    const nextDateString = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;

    // 4. Create the next booking
    const { error: createError } = await supabaseAdmin
      .from("bookings")
      .insert([
        {
          property_id: booking.property_id,
          client_id: booking.properties?.client_id || booking.client_id,
          scheduled_date: nextDateString,
          status: "scheduled",
          actual_price: booking.properties?.mowing_price || booking.actual_price || null,
          notes: null
        }
      ]);

    if (createError) {
      return { error: `Completed current booking, but failed to schedule the next occurrence: ${createError.message}` };
    }

    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to complete booking and schedule next" };
  }
}
