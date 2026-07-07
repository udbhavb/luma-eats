export interface TimeOption { id: string; iso: string; by: string; votes: string[]; }
export interface Cuisine { id: string; name: string; emoji: string; by: string; votes: string[]; }
export interface Place {
  id: string; name: string; cuisine: string; address: string;
  lat: number | null; lng: number | null;
  rating: number | null; ratingCount: number | null; priceLevel: number | null;
  mapsUrl: string; source: string; by: string; votes: string[];
}
export interface Message { id: string; author: string; text: string; at: number; }
export interface SessionState {
  id: string; name: string; createdAt: number;
  decideBy: string | null;
  location: { lat: number; lng: number; label: string } | null;
  timeFinal: string | null; placeFinal: string | null;
  members: string[];
  timeOptions: TimeOption[];
  cuisines: Cuisine[];
  places: Place[];
  messages: Message[];
}
export interface Candidate {
  name: string; cuisine: string; address: string;
  lat: number | null; lng: number | null;
  rating: number | null; ratingCount: number | null; priceLevel: number | null;
  mapsUrl: string; source: string; distKm: number | null;
}
export interface AppConfig { ai: boolean; placesProvider: "google" | "osm"; }
export interface Recommendation { placeId: string; reasoning: string; runnerUpId: string | null; }
