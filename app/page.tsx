"use client";

import { useState } from "react";
import dynamic from "next/dynamic";

const PropertyMapView = dynamic(() => import("@/components/PropertyMapView"), {
  ssr: false,
  loading: () => (
    <div
      className="flex w-full items-center justify-center bg-zinc-900 text-sm font-medium text-zinc-400"
      style={{ height: "100dvh", minHeight: "100vh" }}
    >
      Loading Garupe map…
    </div>
  ),
});

const PropertyCalendarView = dynamic(() => import("@/components/PropertyCalendarView"), {
  ssr: false,
  loading: () => (
    <div
      className="flex w-full items-center justify-center bg-zinc-900 text-sm font-medium text-zinc-400"
      style={{ height: "100dvh", minHeight: "100vh" }}
    >
      Loading Mowing Calendar…
    </div>
  ),
});

export default function Home() {
  const [activeView, setActiveView] = useState<"map" | "calendar">("map");

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-zinc-900">
      {/* 
        Keep the map mounted in the background to preserve its loaded state, 
        markers, and current zoom position.
      */}
      <div 
        className={`absolute inset-0 w-full h-full transition-opacity duration-300 ${
          activeView === "map" 
            ? "opacity-100 z-10 pointer-events-auto" 
            : "opacity-0 z-0 pointer-events-none"
        }`}
      >
        <PropertyMapView onViewCalendar={() => setActiveView("calendar")} />
      </div>

      {activeView === "calendar" && (
        <div className="absolute inset-0 w-full h-full z-20 bg-zinc-900">
          <PropertyCalendarView onBackToMap={() => setActiveView("map")} />
        </div>
      )}
    </div>
  );
}
