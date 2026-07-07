import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface Pin { lat: number; lng: number; label: string; highlight?: boolean; }

export function MapView({ center, pins }: { center: { lat: number; lng: number }; pins: Pin[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = L.map(ref.current, { scrollWheelZoom: false }).setView([center.lat, center.lng], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    L.circleMarker([center.lat, center.lng], {
      radius: 7, color: "#2b2320", fillColor: "#2b2320", fillOpacity: 0.9
    }).bindTooltip("You are here-ish").addTo(layer);
    const bounds: L.LatLngTuple[] = [[center.lat, center.lng]];
    for (const p of pins) {
      L.circleMarker([p.lat, p.lng], {
        radius: p.highlight ? 9 : 6,
        color: p.highlight ? "#2f9e6e" : "#e85d3d",
        fillColor: p.highlight ? "#2f9e6e" : "#e85d3d",
        fillOpacity: 0.85
      }).bindTooltip(p.label).addTo(layer);
      bounds.push([p.lat, p.lng]);
    }
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
  }, [center, pins]);

  return <div id="map" ref={ref} />;
}
