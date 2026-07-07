/**
 * Places + geocoding, provider-abstracted:
 *  - GOOGLE_CLOUD_API_KEY present → Google Places API (New) searchText + Geocoding API.
 *    Real ratings & review counts ("best reviewed" done properly).
 *  - No key → OpenStreetMap (Overpass + Nominatim). Free, no key, but no ratings —
 *    results are sorted by distance and the UI links out to Google Maps for reviews.
 */

const GOOGLE_KEY = process.env.GOOGLE_CLOUD_API_KEY?.trim();
const isRealKey = !!GOOGLE_KEY && !/^x+$/i.test(GOOGLE_KEY);

export const placesProvider = isRealKey ? "google" : "osm";

export interface Candidate {
  name: string;
  cuisine: string;
  address: string;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null; // 1-4
  mapsUrl: string;
  source: "google" | "osm";
  distKm: number | null;
}

export interface Geo { lat: number; lng: number; label: string; }

const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const fallbackMapsUrl = (name: string, address?: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + (address ? ", " + address : ""))}`;

/* ---------------- geocoding ---------------- */

export async function geocode(query: string): Promise<Geo> {
  if (isRealKey) {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_KEY}`
    );
    const j: any = await r.json();
    const hit = j.results?.[0];
    if (!hit) throw new Error("Address not found");
    return {
      lat: hit.geometry.location.lat,
      lng: hit.geometry.location.lng,
      label: hit.formatted_address.split(",").slice(0, 2).join(",")
    };
  }
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": "luma-eat-take-home/1.0" } }
  );
  const j: any = await r.json();
  if (!j.length) throw new Error("Address not found");
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name.split(",").slice(0, 2).join(",") };
}

/* ---------------- search ---------------- */

export async function searchPlaces(loc: Geo, cuisines: string[]): Promise<Candidate[]> {
  const results = isRealKey ? await googleSearch(loc, cuisines) : await osmSearch(loc, cuisines);
  return results
    .map(p => ({ ...p, distKm: p.lat != null ? +haversineKm(loc, { lat: p.lat, lng: p.lng! }).toFixed(2) : null }))
    .filter(p => p.distKm == null || p.distKm <= 12) // hard cap: nothing "nearby" is 12km+ away
    .sort((a, b) =>
      // rating-weighted when available (Bayesian-ish shrink toward 4.0 so 2 reviews at 5.0 don't win),
      // distance otherwise
      (score(b) - score(a)) || ((a.distKm ?? 99) - (b.distKm ?? 99))
    )
    .slice(0, 18);
}

const score = (p: Candidate) =>
  p.rating != null && p.ratingCount != null
    ? (p.rating * p.ratingCount + 4.0 * 20) / (p.ratingCount + 20)
    : 0;

const PRICE_MAP: Record<string, number> = {
  PRICE_LEVEL_FREE: 1, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4
};

async function googleSearch(loc: Geo, cuisines: string[]): Promise<Candidate[]> {
  const textQuery = cuisines.length
    ? `best ${cuisines.join(" or ")} restaurants`
    : "best restaurants";
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY!,
      "X-Goog-FieldMask": [
        "places.displayName", "places.rating", "places.userRatingCount",
        "places.priceLevel", "places.formattedAddress", "places.location",
        "places.googleMapsUri", "places.primaryTypeDisplayName"
      ].join(",")
    },
    body: JSON.stringify({
      textQuery,
      maxResultCount: 20,
      // locationRestriction, not locationBias — bias is merely a hint and
      // Google will happily return matches from the other coast. searchText
      // only supports rectangles, so: ~5km box around the group.
      locationRestriction: {
        rectangle: {
          low: { latitude: loc.lat - 0.045, longitude: loc.lng - 0.045 / Math.cos(loc.lat * Math.PI / 180) },
          high: { latitude: loc.lat + 0.045, longitude: loc.lng + 0.045 / Math.cos(loc.lat * Math.PI / 180) }
        }
      }
    })
  });
  if (!r.ok) throw new Error(`Google Places error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return (j.places ?? []).map((p: any): Candidate => ({
    name: p.displayName?.text ?? "Unknown",
    cuisine: p.primaryTypeDisplayName?.text ?? "",
    address: p.formattedAddress ?? "",
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    priceLevel: p.priceLevel ? PRICE_MAP[p.priceLevel] ?? null : null,
    mapsUrl: p.googleMapsUri ?? fallbackMapsUrl(p.displayName?.text ?? ""),
    source: "google",
    distKm: null
  }));
}

/* OSM cuisine-tag mapping for common answers */
const OSM_CUISINE: Record<string, string> = {
  italian: "italian|pasta|pizza", mexican: "mexican|tacos|burrito", japanese: "japanese|ramen|sushi",
  indian: "indian", chinese: "chinese", thai: "thai", burgers: "burger",
  korean: "korean", mediterranean: "mediterranean|greek|lebanese|turkish",
  vietnamese: "vietnamese", bbq: "bbq|barbecue", vegan: "vegan|vegetarian",
  sushi: "sushi|japanese", pizza: "pizza"
};

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

/* overpass-api.de rejects "bot-shaped" requests (406) since its 2024 AI-scraper
 * filters: it wants a descriptive User-Agent with a contact and a real Accept.
 * Public mirrors also rate-limit per IP (429), so successful responses are
 * cached for 5 minutes — a group of 8 poking at the same block should cost
 * one upstream request, not eight. */
const OSM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "LumaEat/1.0 (group lunch picker; udbhavbhatnagar@gmail.com)",
  "Accept": "application/json",
  "Accept-Language": "en"
};

const osmCache = new Map<string, { at: number; data: any }>();
const OSM_CACHE_TTL = 5 * 60 * 1000;

async function osmSearch(loc: Geo, cuisines: string[]): Promise<Candidate[]> {
  const frag = cuisines
    .map(c => OSM_CUISINE[c.toLowerCase()] ?? c.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean).join("|");
  const filter = frag ? `["cuisine"~"${frag}",i]` : "";
  const around = `(around:2500,${loc.lat.toFixed(3)},${loc.lng.toFixed(3)})`;
  // [timeout:8] caps work server-side; the AbortSignal caps the wall clock —
  // a 504-ing mirror must fail fast so the next one gets its turn
  const q = `[out:json][timeout:8];(
    node["amenity"~"restaurant|fast_food"]${filter}${around};
    way["amenity"~"restaurant|fast_food"]${filter}${around};
  );out center tags 60;`;

  const cacheKey = around + "|" + frag;
  const hit = osmCache.get(cacheKey);
  if (hit && Date.now() - hit.at < OSM_CACHE_TTL) return parseOsm(hit.data);

  let data: any = null;
  // random order spreads load across mirrors instead of dogpiling the first
  const mirrors = [...OVERPASS_URLS].sort(() => Math.random() - 0.5);
  for (const url of mirrors) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: OSM_HEADERS,
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(10_000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
      break;
    } catch (e) { console.warn(`Overpass ${url} failed:`, (e as Error).message); }
  }
  if (!data) throw new Error("Free places service unreachable — try again in ~30s, or add places manually below");
  if (osmCache.size > 200) osmCache.clear();
  osmCache.set(cacheKey, { at: Date.now(), data });
  return parseOsm(data);
}

function parseOsm(data: any): Candidate[] {

  const seen = new Set<string>();
  return (data.elements ?? []).flatMap((el: any): Candidate[] => {
    const t = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (!t.name || lat == null || seen.has(t.name)) return [];
    seen.add(t.name);
    const address = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
    return [{
      name: t.name,
      cuisine: (t.cuisine ?? "").split(";")[0].replace(/_/g, " "),
      address, lat, lng,
      rating: null, ratingCount: null, priceLevel: null,
      mapsUrl: fallbackMapsUrl(t.name, address),
      source: "osm", distKm: null
    }];
  });
}
