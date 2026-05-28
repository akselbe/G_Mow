"use client";

import dynamic from "next/dynamic";

const PropertyMapView = dynamic(() => import("@/components/PropertyMapView"), {
  ssr: false,
  loading: () => (
    <div
      className="flex w-full items-center justify-center bg-zinc-100 text-sm font-medium text-zinc-700"
      style={{ height: "100dvh", minHeight: "100vh" }}
    >
      Loading Garupe map…
    </div>
  ),
});

export default function Home() {
  return <PropertyMapView />;
}
