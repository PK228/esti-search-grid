// Read ?s= early so STORAGE_KEY can be namespaced per-search.
const _urlParams = new URLSearchParams(window.location.search);
export const SEARCH_ID = _urlParams.get("s") || null;

export const STORAGE_KEY = `esti-grid-${SEARCH_ID || "default"}`;
export const LEGACY_STORAGE_KEY = "toronto-search-grid-v2";
export const SESSION_KEY = "toronto-search-grid-session";
export const SESSION_STARTED_KEY = "toronto-search-grid-session-started";
export const POSITIONS_KEY_STORE = "esti-search-grid-positions-key";
export const STALE_AFTER_MINUTES = 30;
export const HEARTBEAT_WARNING_MINUTES = 20;
export const HEARTBEAT_SCAN_MS = 60 * 1000;
export const GRID_CELL_KM = 0.5;
export const LABEL_MIN_ZOOM = 12 + Math.round(Math.log2(1 / GRID_CELL_KM));
export const SHARED_API_BASE = location.hostname.endsWith("github.io")
  ? "https://esti-search-grid.vercel.app"
  : "";
export const SHARED_STATE_API = `${SHARED_API_BASE}/api/state`;
export const SHARED_POLL_MS = 3500;
export const POSITIONS_API = `${SHARED_API_BASE}/api/positions`;
export const POSITION_SYNC_MS = 30 * 1000;
export const POSITION_FRESH_MS = 60 * 1000;
export const POSITION_STALE_MS = 5 * 60 * 1000;
export const POSITION_IDLE_MS = 30 * 60 * 1000;

export const SEARCH_AREA = {
  name: "Keele / Yonge / Steeles / Eglinton",
  boundary: [
    [-79.4935, 43.7823],
    [-79.4196, 43.7983],
    [-79.3985, 43.7064],
    [-79.4752, 43.6907],
    [-79.4935, 43.7823],
  ],
};

// Extended search ring: DVP/404 (east) / Hwy 400 (west) / Bloor (south) / Hwy 407 (north).
// Cells here use E- prefix (e.g. E-A01) and never overlap the primary area.
export const SEARCH_AREA_EXTENDED = {
  name: "Extended — DVP / Hwy 400 / Bloor / Hwy 407",
  boundary: [
    [-79.36935, 43.84043],
    [-79.33777, 43.77007],
    [-79.32472, 43.71601],
    [-79.34052, 43.69864],
    [-79.34824, 43.69791],
    [-79.35871, 43.67135],
    [-79.34875, 43.65198],
    [-79.41158, 43.63732],
    [-79.43338, 43.63297],
    [-79.4557,  43.63931],
    [-79.47235, 43.63446],
    [-79.48317, 43.62738],
    [-79.54857, 43.61434],
    [-79.57586, 43.67246],
    [-79.59045, 43.67084],
    [-79.63165, 43.75222],
    [-79.6344,  43.77058],
    [-79.54411, 43.79016],
    [-79.54754, 43.82807],
    [-79.50823, 43.83488],
    [-79.43416, 43.85278],
    [-79.41158, 43.85767],
    [-79.37502, 43.86522],
    [-79.36901, 43.84053],
    [-79.36935, 43.84043],
  ],
};

export const STATUS = {
  open: {
    label: "Open",
    className: "status-open",
    color: "#2f3845",
    fill: "#ffffff",
    opacity: 0.08,
  },
  searching: {
    label: "Searching",
    className: "status-searching",
    color: "#154fc0",
    fill: "#2563eb",
    opacity: 0.28,
  },
  done: {
    label: "Search complete",
    className: "status-done",
    color: "#12632f",
    fill: "#16a34a",
    opacity: 0.34,
  },
  stopped: {
    label: "Stopped",
    className: "status-stopped",
    color: "#334155",
    fill: "#64748b",
    opacity: 0.3,
  },
  backup: {
    label: "Needs backup",
    className: "status-backup",
    color: "#8b3f05",
    fill: "#f59e0b",
    opacity: 0.42,
  },
  emergency: {
    label: "Emergency",
    className: "status-emergency",
    color: "#991b1b",
    fill: "#ef4444",
    opacity: 0.48,
  },
  found: {
    label: "Found Esti",
    className: "status-found",
    color: "#9f1239",
    fill: "#e11d48",
    opacity: 0.52,
  },
  stale: {
    label: "Stale released",
    className: "status-stale",
    color: "#92400e",
    fill: "#fbbf24",
    opacity: 0.3,
  },
};

export const ESCALATION_STATUSES = new Set(["backup", "emergency", "found"]);
export const CLOSED_STATUSES = new Set(["done", "stopped"]);

// Koester/ISRID distance rings (km) from IPP by lost-person category.
// P25/P50/P75/P95 percentiles from the International Search & Rescue Incident Database.
export const KOESTER_CATEGORIES = [
  { id: "dementia",     label: "Dementia / Alzheimer's" },
  { id: "autism",       label: "Autism spectrum" },
  { id: "intellectual", label: "Intellectual disability" },
  { id: "despondent",   label: "Despondent / Suicidal" },
  { id: "child",        label: "Child (under 13)" },
  { id: "other",        label: "Other / Unknown" },
];

export const KOESTER_DISTANCES = {
  dementia:     { p25: 0.5,  p50: 1.2,  p75: 2.3,  p95: 6.4 },
  autism:       { p25: 0.5,  p50: 1.0,  p75: 2.0,  p95: 5.0 },
  intellectual: { p25: 0.5,  p50: 1.1,  p75: 2.1,  p95: 4.5 },
  despondent:   { p25: 1.5,  p50: 2.5,  p75: 4.0,  p95: 8.0 },
  child:        { p25: 0.3,  p50: 0.6,  p75: 1.3,  p95: 3.0 },
  other:        { p25: 0.5,  p50: 1.5,  p75: 3.0,  p95: 7.5 },
};
