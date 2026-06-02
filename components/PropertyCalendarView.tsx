"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchBookingsAction,
  createBookingAction,
  updateBookingAction,
  deleteBookingAction,
  completeBookingAndScheduleNextAction
} from "@/app/actions/bookings";
import {
  fetchAllPropertiesAction,
  fetchAllProfilesAction
} from "@/app/actions/properties";
import {
  formatAddress,
  type BookingRow,
  type BookingWithProperty,
  type PropertyRow,
  type ProfileRow,
  type BookingStatus
} from "@/lib/properties";

interface PropertyCalendarViewProps {
  onBackToMap: () => void;
}

export default function PropertyCalendarView({ onBackToMap }: PropertyCalendarViewProps) {
  // Calendar Navigation State
  const [currentDate, setCurrentDate] = useState(new Date());
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth(); // 0-indexed

  // Data State
  const [bookings, setBookings] = useState<BookingWithProperty[]>([]);
  const [properties, setProperties] = useState<PropertyRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selection & Sidebar State
  const [selectedBooking, setSelectedBooking] = useState<BookingWithProperty | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [bookingNotes, setBookingNotes] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  // New Booking Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalDate, setModalDate] = useState("");
  const [selectedPropertyId, setSelectedPropertyId] = useState("");
  const [newBookingNotes, setNewBookingNotes] = useState("");
  const [customPrice, setCustomPrice] = useState("");

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const daysOfWeek = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // Helper to prevent UTC timezone boundary offset bugs
  const toLocalDateString = (d: Date) => {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // Fetch all necessary data for the current month
  const loadCalendarData = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Calculate date range of current month view (including padded days from previous/next months)
    const firstDayOfMonth = new Date(currentYear, currentMonth, 1);
    const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0);

    // Go back to the preceding Monday, and forward to the succeeding Sunday
    const startOffset = firstDayOfMonth.getDay() === 0 ? 6 : firstDayOfMonth.getDay() - 1;
    const endOffset = lastDayOfMonth.getDay() === 0 ? 0 : 7 - lastDayOfMonth.getDay();

    const startViewDate = new Date(firstDayOfMonth);
    startViewDate.setDate(firstDayOfMonth.getDate() - startOffset);

    const endViewDate = new Date(lastDayOfMonth);
    endViewDate.setDate(lastDayOfMonth.getDate() + endOffset);

    const startStr = toLocalDateString(startViewDate);
    const endStr = toLocalDateString(endViewDate);

    const [bookingsRes, propertiesRes, profilesRes] = await Promise.all([
      fetchBookingsAction(startStr, endStr),
      fetchAllPropertiesAction(),
      fetchAllProfilesAction()
    ]);

    if (bookingsRes.error || propertiesRes.error || profilesRes.error) {
      setError(bookingsRes.error || propertiesRes.error || profilesRes.error);
      setLoading(false);
      return;
    }

    const normalizedProperties = propertiesRes.rows.map((row) => ({
      ...row,
      status: row.status ? row.status.toLowerCase() : null
    }));

    setBookings(bookingsRes.bookings);
    setProperties(normalizedProperties);
    setProfiles(profilesRes.profiles);
    setLoading(false);
  }, [currentYear, currentMonth]);

  useEffect(() => {
    loadCalendarData();
  }, [loadCalendarData]);

  // Calendar calculations
  const calendarCells = useMemo(() => {
    const cells: Date[] = [];
    const firstDay = new Date(currentYear, currentMonth, 1);
    
    // Day of week offset: 0 for Mon, 1 for Tue, ..., 6 for Sun
    let startOffset = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;

    // Fill preceding month's days
    for (let i = startOffset; i > 0; i--) {
      const d = new Date(currentYear, currentMonth, 1 - i);
      cells.push(d);
    }

    // Fill current month's days
    const totalDays = new Date(currentYear, currentMonth + 1, 0).getDate();
    for (let i = 1; i <= totalDays; i++) {
      const d = new Date(currentYear, currentMonth, i);
      cells.push(d);
    }

    // Fill succeeding month's days to complete final week
    const lastDay = new Date(currentYear, currentMonth + 1, 0);
    const endOffset = lastDay.getDay() === 0 ? 0 : 7 - lastDay.getDay();
    for (let i = 1; i <= endOffset; i++) {
      const d = new Date(currentYear, currentMonth + 1, i);
      cells.push(d);
    }

    return cells;
  }, [currentYear, currentMonth]);

  // Group bookings by date string (YYYY-MM-DD)
  const bookingsByDate = useMemo(() => {
    const map: Record<string, BookingWithProperty[]> = {};
    bookings.forEach((booking) => {
      const dateStr = booking.scheduled_date;
      if (!map[dateStr]) map[dateStr] = [];
      map[dateStr].push(booking);
    });
    return map;
  }, [bookings]);

  // Find profile/client details for selected property
  const getClientForProperty = useCallback((clientId: string | null) => {
    if (!clientId) return null;
    return profiles.find((p) => p.id === clientId) || null;
  }, [profiles]);

  // Handler for navigation
  const prevMonth = () => {
    setCurrentDate(new Date(currentYear, currentMonth - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentYear, currentMonth + 1, 1));
  };

  const selectBooking = (booking: BookingWithProperty) => {
    setSelectedBooking(booking);
    setBookingNotes(booking.notes || "");
    setIsSidebarOpen(true);
  };

  const openScheduleModal = (date: Date) => {
    const formatted = toLocalDateString(date);
    setModalDate(formatted);
    setSelectedPropertyId("");
    setNewBookingNotes("");
    setCustomPrice("");
    setIsModalOpen(true);
  };

  // Actions
  const handleCompleteAndScheduleNext = async () => {
    if (!selectedBooking) return;
    setActionBusy(true);

    const { error: actionError } = await completeBookingAndScheduleNextAction(
      selectedBooking.id,
      bookingNotes
    );

    if (actionError) {
      alert(actionError);
      setActionBusy(false);
      return;
    }

    await loadCalendarData();
    setIsSidebarOpen(false);
    setSelectedBooking(null);
    setActionBusy(false);
  };

  const handleUpdateStatus = async (status: BookingStatus) => {
    if (!selectedBooking) return;
    setActionBusy(true);

    const payload: Partial<BookingRow> = { status, notes: bookingNotes };
    if (status === "completed") {
      payload.completed_at = new Date().toISOString();
    }

    const { error: actionError } = await updateBookingAction(selectedBooking.id, payload);

    if (actionError) {
      alert(actionError);
      setActionBusy(false);
      return;
    }

    await loadCalendarData();
    
    // Update local selected state
    setSelectedBooking((prev) => {
      if (!prev) return null;
      return { ...prev, ...payload };
    });

    setActionBusy(false);
  };

  const handleDeleteBooking = async () => {
    if (!selectedBooking) return;
    if (!confirm("Are you sure you want to delete this scheduled job?")) return;
    setActionBusy(true);

    const { error: actionError } = await deleteBookingAction(selectedBooking.id);

    if (actionError) {
      alert(actionError);
      setActionBusy(false);
      return;
    }

    await loadCalendarData();
    setIsSidebarOpen(false);
    setSelectedBooking(null);
    setActionBusy(false);
  };

  const handleReschedule = async (newDateStr: string) => {
    if (!selectedBooking) return;
    setActionBusy(true);

    const { error: actionError } = await updateBookingAction(selectedBooking.id, {
      scheduled_date: newDateStr
    });

    if (actionError) {
      alert(actionError);
      setActionBusy(false);
      return;
    }

    await loadCalendarData();
    
    // Update local selected state
    setSelectedBooking((prev) => {
      if (!prev) return null;
      return { ...prev, scheduled_date: newDateStr };
    });
    
    setActionBusy(false);
  };

  const handleCreateBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPropertyId || !modalDate) return;

    setActionBusy(true);
    const prop = properties.find((p) => p.id === selectedPropertyId);
    const priceVal = customPrice ? Number(customPrice) : (prop?.mowing_price || null);

    const { error: actionError } = await createBookingAction({
      property_id: selectedPropertyId,
      scheduled_date: modalDate,
      notes: newBookingNotes || undefined,
      actual_price: priceVal || undefined
    });

    if (actionError) {
      alert(actionError);
      setActionBusy(false);
      return;
    }

    await loadCalendarData();
    setIsModalOpen(false);
    setActionBusy(false);
  };

  // Filtering active properties for dropdown list
  const activeProperties = useMemo(() => {
    return properties.filter((p) => p.status === "active" || p.status === "contacted");
  }, [properties]);

  // Color classes for booking tags
  const getBookingColorClasses = (status: BookingStatus) => {
    switch (status) {
      case "completed":
        return "bg-green-100 text-green-800 border-green-200 hover:bg-green-200";
      case "skipped":
        return "bg-zinc-100 text-zinc-600 border-zinc-200 hover:bg-zinc-200";
      case "cancelled":
        return "bg-rose-100 text-rose-800 border-rose-200 hover:bg-rose-200";
      case "scheduled":
      default:
        return "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200";
    }
  };

  const activeBookingClient = useMemo(() => {
    return selectedBooking ? getClientForProperty(selectedBooking.properties?.client_id || null) : null;
  }, [selectedBooking, getClientForProperty]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-900 text-zinc-100 font-sans">
      
      {/* Main Calendar Body */}
      <div className="flex flex-1 flex-col overflow-hidden p-6 gap-4">
        
        {/* Top bar control */}
        <div className="flex items-center justify-between bg-zinc-800/80 backdrop-blur-md rounded-2xl px-6 py-4 border border-zinc-700/60 shadow-xl">
          
          <div className="flex items-center gap-4">
            <button
              onClick={onBackToMap}
              className="flex items-center gap-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 px-4 py-2 text-sm font-semibold transition"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Back to Map
            </button>
            <h1 className="text-xl font-bold tracking-tight">Mowing Schedule</h1>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={prevMonth}
              className="p-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 transition"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-md font-bold min-w-[120px] text-center">
              {monthNames[currentMonth]} {currentYear}
            </span>
            <button
              onClick={nextMonth}
              className="p-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 transition"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              onClick={() => setCurrentDate(new Date())}
              className="px-3.5 py-2 rounded-xl bg-green-700 hover:bg-green-600 text-xs font-bold uppercase transition"
            >
              Today
            </button>
          </div>
        </div>

        {/* Calendar Grid */}
        <div className="flex-1 bg-zinc-800/40 backdrop-blur-sm rounded-3xl border border-zinc-700/40 p-4 shadow-2xl overflow-hidden flex flex-col">
          
          {/* Days of week header */}
          <div className="grid grid-cols-7 gap-2 mb-2 text-center text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            {daysOfWeek.map((day) => (
              <div key={day} className="py-2">{day}</div>
            ))}
          </div>

          {/* Grid dates */}
          <div className="grid grid-cols-7 grid-rows-5 flex-1 gap-2 overflow-y-auto">
            {calendarCells.map((date, index) => {
              const dateStr = toLocalDateString(date);
              const dayBookings = bookingsByDate[dateStr] || [];
              const isToday = new Date().toDateString() === date.toDateString();
              const isCurrentMonth = date.getMonth() === currentMonth;

              return (
                <div
                  key={index}
                  onClick={() => openScheduleModal(date)}
                  className={`group flex flex-col p-2.5 rounded-2xl border transition-all cursor-pointer min-h-[80px] overflow-hidden ${
                    isCurrentMonth 
                      ? "bg-zinc-800/60 border-zinc-700/50 hover:bg-zinc-700/50" 
                      : "bg-zinc-900/40 border-zinc-800/30 text-zinc-600 hover:bg-zinc-800/20"
                  } ${isToday ? "ring-2 ring-green-600/80 border-green-600/50 bg-green-950/20" : ""}`}
                >
                  {/* Cell Header */}
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center ${
                      isToday ? "bg-green-600 text-white" : ""
                    }`}>
                      {date.getDate()}
                    </span>
                    <span className="opacity-0 group-hover:opacity-100 transition text-[10px] text-green-500 font-semibold uppercase">
                      + Add
                    </span>
                  </div>

                  {/* Booking items inside cell */}
                  <div className="flex flex-col gap-1 overflow-y-auto flex-1 max-h-[85px] no-scrollbar">
                    {dayBookings.map((b) => {
                      const addr = formatAddress(b.properties?.street_name, b.properties?.house_number);
                      return (
                        <div
                          key={b.id}
                          onClick={(e) => {
                            e.stopPropagation(); // Avoid triggering scheduling modal
                            selectBooking(b);
                          }}
                          className={`text-[10px] font-semibold px-2 py-1 rounded-lg border text-ellipsis overflow-hidden whitespace-nowrap transition shadow-sm ${getBookingColorClasses(b.status)}`}
                        >
                          {addr || "Property ID: " + b.property_id.substring(0, 5)}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

        </div>
      </div>

      {/* Booking Details Sidebar */}
      {isSidebarOpen && selectedBooking && (
        <div className="w-[380px] border-l border-zinc-700/80 bg-zinc-800/95 backdrop-blur-md shadow-2xl p-6 overflow-y-auto flex flex-col gap-6 transition-all duration-300">
          
          <div className="flex items-center justify-between border-b border-zinc-700/80 pb-4">
            <h2 className="text-lg font-bold">Booking Details</h2>
            <button
              onClick={() => setIsSidebarOpen(false)}
              className="p-1 rounded-lg hover:bg-zinc-700 transition"
            >
              <svg className="h-5 w-5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Property Info */}
          <div className="flex flex-col gap-3 bg-zinc-900/60 p-4 rounded-2xl border border-zinc-700/40">
            <div>
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Property Address</span>
              <p className="text-sm font-semibold mt-0.5">
                {formatAddress(selectedBooking.properties?.street_name, selectedBooking.properties?.house_number) || "—"}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Cadastre #</span>
                <p className="text-xs font-semibold mt-0.5">{selectedBooking.properties?.cadastre_number || "—"}</p>
              </div>
              <div>
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Area Sqm</span>
                <p className="text-xs font-semibold mt-0.5">
                  {selectedBooking.properties?.area_sqm ? `${selectedBooking.properties.area_sqm} m²` : "—"}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Scheduled Price</span>
                <p className="text-xs font-semibold text-green-500 mt-0.5">
                  {selectedBooking.actual_price ? `€${selectedBooking.actual_price}` : `€${selectedBooking.properties?.mowing_price || "—"}`}
                </p>
              </div>
              <div>
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Frequency</span>
                <p className="text-xs font-semibold capitalize mt-0.5">{selectedBooking.properties?.mowing_frequency || "—"}</p>
              </div>
            </div>
          </div>

          {/* Client Details */}
          <div className="flex flex-col gap-3 bg-zinc-900/60 p-4 rounded-2xl border border-zinc-700/40">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Client Profile</span>
            {activeBookingClient ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-semibold">
                  {activeBookingClient.first_name} {activeBookingClient.last_name}
                </p>
                <div className="flex items-center gap-1 text-xs text-zinc-400">
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.94.725l.548 2.2a1 1 0 01-.321.988l-1.305.98a10.582 10.582 0 004.872 4.872l.98-1.305a1 1 0 01.988-.321l2.2.548a1 1 0 01.725.94V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  <span>{activeBookingClient.phone_number || "No phone"}</span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-zinc-500 italic">No client profile linked</p>
            )}
          </div>

          {/* Booking Info */}
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Scheduled Date</label>
                <input
                  type="date"
                  value={selectedBooking.scheduled_date}
                  onChange={(e) => handleReschedule(e.target.value)}
                  disabled={actionBusy}
                  className="w-full mt-1 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs outline-none focus:border-green-600 transition"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Status</label>
                <div className="mt-1 flex items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-bold uppercase tracking-wider capitalize">
                  {selectedBooking.status}
                </div>
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Admin / Driver Notes</label>
              <textarea
                value={bookingNotes}
                onChange={(e) => setBookingNotes(e.target.value)}
                placeholder="Enter completion details, height notes, etc..."
                className="w-full mt-1 h-20 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs outline-none focus:border-green-600 transition resize-none"
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-2 mt-auto border-t border-zinc-700/80 pt-4">
            {selectedBooking.status === "scheduled" && (
              <>
                <button
                  onClick={handleCompleteAndScheduleNext}
                  disabled={actionBusy}
                  className="w-full py-3 rounded-xl bg-green-700 hover:bg-green-600 text-sm font-semibold uppercase tracking-wider transition shadow-lg flex items-center justify-center gap-2"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Complete & Schedule Next
                </button>
                
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleUpdateStatus("skipped")}
                    disabled={actionBusy}
                    className="py-2.5 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-xs font-semibold uppercase tracking-wider transition"
                  >
                    Skip Occurrence
                  </button>
                  <button
                    onClick={() => handleUpdateStatus("cancelled")}
                    disabled={actionBusy}
                    className="py-2.5 rounded-xl bg-zinc-700 hover:bg-rose-950 text-xs font-semibold uppercase tracking-wider hover:text-rose-200 transition"
                  >
                    Cancel Mowing
                  </button>
                </div>
              </>
            )}

            {selectedBooking.status !== "scheduled" && (
              <button
                onClick={() => handleUpdateStatus("scheduled")}
                disabled={actionBusy}
                className="w-full py-3 rounded-xl bg-blue-700 hover:bg-blue-600 text-sm font-semibold uppercase tracking-wider transition shadow-lg"
              >
                Revert to Scheduled
              </button>
            )}

            <button
              onClick={handleDeleteBooking}
              disabled={actionBusy}
              className="w-full py-2.5 mt-2 rounded-xl bg-zinc-900 border border-zinc-800 text-rose-500 hover:bg-rose-950 hover:border-rose-900 hover:text-rose-200 text-xs font-bold uppercase tracking-wider transition"
            >
              Delete Scheduled Job
            </button>
          </div>

        </div>
      )}

      {/* New Booking Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[420px] bg-zinc-800 rounded-3xl p-6 border border-zinc-700 shadow-2xl flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-zinc-700 pb-3">
              <h3 className="text-md font-bold">Schedule Mowing</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1 rounded-lg hover:bg-zinc-700 transition"
              >
                <svg className="h-5 w-5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreateBooking} className="flex flex-col gap-4">
              
              <div>
                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Select Property</label>
                <select
                  required
                  value={selectedPropertyId}
                  onChange={(e) => {
                    setSelectedPropertyId(e.target.value);
                    const prop = properties.find((p) => p.id === e.target.value);
                    setCustomPrice(prop?.mowing_price ? String(prop.mowing_price) : "");
                  }}
                  className="w-full mt-1 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2.5 text-xs outline-none focus:border-green-600 transition"
                >
                  <option value="">-- Choose active client property --</option>
                  {activeProperties.map((p) => {
                    const addr = formatAddress(p.street_name, p.house_number);
                    const client = getClientForProperty(p.client_id);
                    const clientLabel = client ? ` (${client.first_name} ${client.last_name})` : "";
                    return (
                      <option key={p.id} value={p.id}>
                        {addr || `Cadastre: ${p.cadastre_number}`} {clientLabel}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Date</label>
                  <input
                    type="date"
                    required
                    value={modalDate}
                    onChange={(e) => setModalDate(e.target.value)}
                    className="w-full mt-1 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs outline-none focus:border-green-600 transition"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Custom Price (€)</label>
                  <input
                    type="number"
                    value={customPrice}
                    onChange={(e) => setCustomPrice(e.target.value)}
                    placeholder="Leave empty for default"
                    className="w-full mt-1 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs outline-none focus:border-green-600 transition"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Scheduler Notes</label>
                <textarea
                  value={newBookingNotes}
                  onChange={(e) => setNewBookingNotes(e.target.value)}
                  placeholder="E.g. tall grass, dog in yard..."
                  className="w-full mt-1 h-20 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs outline-none focus:border-green-600 transition resize-none"
                />
              </div>

              <button
                type="submit"
                disabled={actionBusy}
                className="w-full py-3 mt-2 rounded-xl bg-green-700 hover:bg-green-600 text-sm font-semibold uppercase tracking-wider transition shadow-lg"
              >
                Schedule Mowing Session
              </button>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
