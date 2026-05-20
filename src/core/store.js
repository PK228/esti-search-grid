import { POSITIONS_KEY_STORE } from "./constants.js";

// Shared mutable runtime state — not persisted, reset on each page load.
// All modules that need to share Leaflet instances, UI flags, or timer handles import this.
export const store = {
  // Leaflet instances (set during setupMap())
  map: null,
  gridLayer: null,
  boundaryLayer: null,
  extBoundaryLayer: null,
  labelLayer: null,
  volunteerLayer: null,
  lastSeenLayer: null,
  koesterLayer: null,
  cluesLayer: null,
  poiLayer: null,

  // Mode flags
  hastyMode: false,
  hastyPriority: new Map(), // cellId → rank (1 = search first)
  poiMode: false,

  // GPS (managed by gps.js)
  gpsWatchId: null,
  gpsMarker: null,
  gpsAccuracy: null,
  gpsCellId: null,
  lastGpsFix: null,
  didCenterGps: false,
  lastAutoHeartbeatAtByCell: {},
  autoHeartbeatCellId: null,
  autoHeartbeatGoodFixCount: 0,
  autoHeartbeatStatus: "inactive",

  // UI flags (managed by main.js)
  activeCellId: null,
  heatMode: false,
  dispatcherLoginOpen: false,
  placingLastSeen: false,

  // Zone panel (managed by zone-panel.js)
  zonePanelOpen: false,
  activeZoneId: null,
  zoneFilter: { neighborhood: "", priority: "", status: "", query: "" },

  // Grid data (populated by buildGrid())
  cellFeatures: [],
  cellLookup: new Map(),

  // Shared sync state (managed by sync.js)
  sharedSyncStatus: "connecting",
  sharedSyncTimer: null,
  sharedWriteTimer: null,
  sharedWriteInFlight: false,
  sharedWriteQueued: false,
  sharedWritesPaused: true,
  lastSharedUpdatedAt: "",

  // POI overlay state (managed by map.js)
  poiElements: [],
  poiFilter: new Set(["hospital", "pharmacy", "police", "community_centre", "shelter", "subway_entrance", "bus_stop", "park"]),

  // Volunteer positions (managed by positions.js)
  positionsKey: localStorage.getItem(POSITIONS_KEY_STORE) || "",
  positionSyncTimer: null,

  // Timers
  staleTimer: null,

  // Boundary tracing tool (managed by map.js)
  traceBoundaryMode: false,
};
