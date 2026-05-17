const STORAGE_KEY = "toronto-search-grid-v2";
const LEGACY_STORAGE_KEY = "toronto-search-grid-v1";
const SESSION_KEY = "toronto-search-grid-session";
const SESSION_STARTED_KEY = "toronto-search-grid-session-started";
const POSITIONS_KEY_STORE = "esti-search-grid-positions-key";
const DISPATCHER_PIN = "2468";
const STALE_AFTER_MINUTES = 30;
const HEARTBEAT_WARNING_MINUTES = 20;
const HEARTBEAT_SCAN_MS = 60 * 1000;
const GRID_CELL_KM = 0.5;
// Smaller squares need more zoom before their ID labels stop overlapping.
const LABEL_MIN_ZOOM = 12 + Math.round(Math.log2(1 / GRID_CELL_KM));
const SHARED_API_BASE = location.hostname.endsWith("github.io")
  ? "https://esti-search-grid.vercel.app"
  : "";
const SHARED_STATE_API = `${SHARED_API_BASE}/api/state`;
const SHARED_POLL_MS = 3500;
const POSITIONS_API = `${SHARED_API_BASE}/api/positions`;
const POSITION_SYNC_MS = 30 * 1000;
const POSITION_IDLE_MS = 10 * 60 * 1000;

const SEARCH_AREA = {
  name: "Keele / Yonge / Steeles / Eglinton",
  // Approximate intersection coordinates, clockwise from northwest.
  // The map tiles provide street-level context; these points define the grid mask.
  boundary: [
    [-79.4935, 43.7823],
    [-79.4196, 43.7983],
    [-79.3985, 43.7064],
    [-79.4752, 43.6907],
    [-79.4935, 43.7823],
  ],
};

const STATUS = {
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

const ESCALATION_STATUSES = new Set(["backup", "emergency", "found"]);
const CLOSED_STATUSES = new Set(["done", "stopped"]);
clearLocalStateIfRequested();
const session = getSession();
const state = loadState();
let map;
let gridLayer;
let boundaryLayer;
let labelLayer;
let volunteerLayer;
let lastGpsFix = null;
let positionSyncTimer = null;
let positionsKey = localStorage.getItem(POSITIONS_KEY_STORE) || "";
let gpsMarker;
let gpsAccuracy;
let gpsWatchId = null;
let gpsCellId = null;
let activeCellId = null;
let didCenterGps = false;
let heatMode = false;
let dispatcherLoginOpen = false;
let staleTimer = null;
let cellFeatures = [];
let cellLookup = new Map();
let toastTimer = null;
let sharedSyncStatus = "connecting";
let sharedSyncTimer = null;
let sharedWriteTimer = null;
let sharedWriteInFlight = false;
let sharedWriteQueued = false;
let sharedWritesPaused = true;
let lastSharedUpdatedAt = "";

document.addEventListener("DOMContentLoaded", init);

function init() {
  if (!window.L || !window.turf) {
    showFatal();
    return;
  }

  ensureIdentity();
  buildGrid();
  scanStaleCells({ silent: true });
  setupMap();
  bindGlobalActions();
  renderPanel();
  updateGpsStatus("GPS idle");
  refreshModeButtons();
  startSharedSync();
  startPositionSync();
  staleTimer = window.setInterval(() => scanStaleCells(), HEARTBEAT_SCAN_MS);
}

function showFatal() {
  document.body.innerHTML =
    '<main class="panel"><h1>Map failed to load</h1><p class="muted">Check the internet connection and refresh this page.</p></main>';
}

function clearLocalStateIfRequested() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("reset")) {
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_STARTED_KEY);
  window.history.replaceState(null, "", window.location.pathname);
}

function getSession() {
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  let startedAt = sessionStorage.getItem(SESSION_STARTED_KEY);

  if (!sessionId) {
    sessionId = makeId("sess");
    startedAt = new Date().toISOString();
    sessionStorage.setItem(SESSION_KEY, sessionId);
    sessionStorage.setItem(SESSION_STARTED_KEY, startedAt);
  }

  return { id: sessionId, startedAt };
}

function loadState() {
  const fallback = {
    cells: {},
    profile: defaultProfile(),
    audit: [],
    incidents: [],
  };

  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const saved = JSON.parse(raw);
    return {
      cells: normalizeCells(saved.cells || {}),
      profile: { ...defaultProfile(), ...(saved.profile || {}) },
      audit: Array.isArray(saved.audit) ? saved.audit : [],
      incidents: Array.isArray(saved.incidents) ? saved.incidents : [],
    };
  } catch {
    return fallback;
  }
}

function defaultProfile() {
  return {
    userId: "",
    name: "",
    contact: "",
    team: "",
    role: "volunteer",
    dispatcher: false,
    phoneVerified: false,
    verificationCode: "",
    verificationSentAt: "",
    verifiedAt: "",
    createdAt: "",
    lastSeenAt: "",
  };
}

function normalizeCells(cells) {
  if (!cells || typeof cells !== "object") {
    return {};
  }
  Object.values(cells).forEach((cell) => {
    if (!cell || typeof cell !== "object") {
      return;
    }
    if (!Array.isArray(cell.searchers)) {
      // Migrate legacy single-owner cells into a one-person searcher list.
      if (cell.status === "searching" && cell.userId) {
        cell.searchers = [
          {
            userId: cell.userId,
            sessionId: cell.sessionId || "",
            name: cell.name || "",
            contact: cell.contact || "",
            team: cell.team || "",
            phoneVerified: Boolean(cell.phoneVerified),
            joinedAt: cell.assignedAt || cell.updatedAt || cell.createdAt || "",
            lastHeartbeatAt: cell.lastHeartbeatAt || cell.updatedAt || "",
          },
        ];
      } else {
        cell.searchers = [];
      }
    }
  });
  return cells;
}

function ensureIdentity() {
  const now = new Date().toISOString();
  if (!state.profile.userId) {
    state.profile.userId = makeId("vol");
    state.profile.createdAt = now;
  }
  state.profile.lastSeenAt = now;
  state.profile.sessionId = session.id;
  state.profile.sessionStartedAt = session.startedAt;
  saveState();
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      cells: state.cells,
      profile: state.profile,
      audit: state.audit,
      incidents: state.incidents,
      savedAt: new Date().toISOString(),
    }),
  );
  scheduleSharedWrite();
}

function sharedPayload() {
  return {
    cells: state.cells,
    audit: state.audit,
    incidents: state.incidents,
  };
}

function setSharedSyncStatus(status, shouldRender = true) {
  sharedSyncStatus = status;
  if (shouldRender && !activeCellId) {
    renderPanel();
  }
}

function startSharedSync() {
  fetchSharedState({ initial: true });
  sharedSyncTimer = window.setInterval(() => {
    fetchSharedState();
  }, SHARED_POLL_MS);
}

async function fetchSharedState(options = {}) {
  try {
    const response = await fetch(`${SHARED_STATE_API}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const remote = payload.state || {};
    if (remote.updatedAt && remote.updatedAt !== lastSharedUpdatedAt) {
      applySharedState(remote);
      lastSharedUpdatedAt = remote.updatedAt;
    }
    sharedWritesPaused = false;
    setSharedSyncStatus("live");
  } catch (error) {
    sharedWritesPaused = false;
    setSharedSyncStatus("offline");
    if (options.initial) {
      showToast("Shared sync is offline; using this device only.");
    }
  }
}

function applySharedState(remote) {
  if (sharedWriteInFlight || sharedWriteQueued) {
    return;
  }

  state.cells = normalizeCells(
    remote.cells && typeof remote.cells === "object" ? remote.cells : {},
  );
  state.audit = Array.isArray(remote.audit) ? remote.audit : [];
  state.incidents = Array.isArray(remote.incidents) ? remote.incidents : [];
  saveLocalOnly();
  refreshGrid();
  renderPanel();
}

function saveLocalOnly() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      cells: state.cells,
      profile: state.profile,
      audit: state.audit,
      incidents: state.incidents,
      savedAt: new Date().toISOString(),
    }),
  );
}

function scheduleSharedWrite() {
  if (sharedWritesPaused) {
    return;
  }
  sharedWriteQueued = true;
  window.clearTimeout(sharedWriteTimer);
  sharedWriteTimer = window.setTimeout(pushSharedState, 250);
}

async function pushSharedState() {
  if (sharedWritesPaused || sharedWriteInFlight) {
    return;
  }

  sharedWriteQueued = false;
  sharedWriteInFlight = true;
  try {
    const response = await fetch(SHARED_STATE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sharedPayload()),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.state?.updatedAt) {
      lastSharedUpdatedAt = payload.state.updatedAt;
    }
    setSharedSyncStatus("live");
  } catch {
    setSharedSyncStatus("offline");
    showToast("Shared sync failed; changes are saved on this phone.");
  } finally {
    sharedWriteInFlight = false;
  }
}

function buildGrid() {
  const boundaryPolygon = turf.polygon([SEARCH_AREA.boundary]);
  const grid = turf.squareGrid(turf.bbox(boundaryPolygon), GRID_CELL_KM, {
    units: "kilometers",
    mask: boundaryPolygon,
  });
  const enriched = grid.features.map((feature) => {
    const center = turf.centroid(feature).geometry.coordinates;
    return {
      feature,
      lng: center[0],
      lat: center[1],
    };
  });

  const rows = [];
  enriched
    .sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .forEach((item) => {
      const row = rows.find(
        (candidate) => Math.abs(candidate.lat - item.lat) < GRID_CELL_KM * 0.0048,
      );
      if (row) {
        row.items.push(item);
        row.lat =
          row.items.reduce((total, current) => total + current.lat, 0) /
          row.items.length;
      } else {
        rows.push({ lat: item.lat, items: [item] });
      }
    });

  rows.sort((a, b) => b.lat - a.lat);
  cellFeatures = rows.flatMap((row, rowIndex) => {
    row.items.sort((a, b) => a.lng - b.lng);
    return row.items.map((item, colIndex) => {
      const id = `${rowLabel(rowIndex)}${String(colIndex + 1).padStart(2, "0")}`;
      item.feature.properties = {
        ...item.feature.properties,
        id,
        center: [item.lng, item.lat],
      };
      cellLookup.set(id, item.feature);
      return item.feature;
    });
  });
}

function rowLabel(index) {
  let label = "";
  let value = index;
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function setupMap() {
  const boundaryLatLng = SEARCH_AREA.boundary.map(([lng, lat]) => [lat, lng]);
  const areaBounds = L.latLngBounds(boundaryLatLng);

  map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  boundaryLayer = L.polygon(boundaryLatLng, {
    color: "#111827",
    weight: 3,
    opacity: 0.95,
    fill: false,
  }).addTo(map);

  gridLayer = L.geoJSON(
    {
      type: "FeatureCollection",
      features: cellFeatures,
    },
    {
      style: getCellStyle,
      onEachFeature(feature, layer) {
        layer.on("click", () => selectCell(feature.properties.id));
        layer.on("mouseover", () => layer.setStyle({ weight: 3 }));
        layer.on("mouseout", () => gridLayer.resetStyle(layer));
      },
    },
  ).addTo(map);

  labelLayer = L.layerGroup().addTo(map);
  volunteerLayer = L.layerGroup().addTo(map);
  renderLabels();
  map.on("zoomend", renderLabels);
  map.fitBounds(areaBounds.pad(0.08));
}

function getCellStyle(feature) {
  const id = feature.properties.id;
  const entry = state.cells[id];
  const statusKey = entry?.status || "open";
  const visual = STATUS[statusKey] || STATUS.open;
  const isSelected = activeCellId === id;
  const isCurrentGps = gpsCellId === id;

  if (heatMode) {
    const count = getGridAuditCount(id);
    const opacity = count ? Math.min(0.18 + count * 0.06, 0.68) : 0.07;
    return {
      color: isSelected ? "#111827" : isCurrentGps ? "#6d28d9" : "#7f1d1d",
      weight: isSelected || isCurrentGps ? 4 : 1.2,
      fillColor: count > 6 ? "#dc2626" : count > 2 ? "#f97316" : "#facc15",
      fillOpacity: opacity,
      opacity: 0.95,
    };
  }

  return {
    color: isSelected ? "#111827" : isCurrentGps ? "#6d28d9" : visual.color,
    weight: isSelected ? 4 : isCurrentGps ? 4 : 1.2,
    fillColor: visual.fill,
    fillOpacity: isSelected ? Math.max(visual.opacity, 0.42) : visual.opacity,
    opacity: 0.95,
  };
}

function renderLabels() {
  labelLayer.clearLayers();
  if (map.getZoom() < LABEL_MIN_ZOOM) {
    return;
  }

  cellFeatures.forEach((feature) => {
    const [lng, lat] = feature.properties.center;
    const id = feature.properties.id;
    const count = searcherCount(state.cells[id]);
    const badge = count > 0 ? `<span class="cell-count">${count}</span>` : "";
    const label = L.marker([lat, lng], {
      interactive: false,
      icon: L.divIcon({
        className: "cell-label",
        html: `<span class="cell-id">${id}</span>${badge}`,
        iconSize: [46, 20],
        iconAnchor: [23, 10],
      }),
    });
    labelLayer.addLayer(label);
  });
}

function bindGlobalActions() {
  document.getElementById("locateBtn").addEventListener("click", toggleGps);
  document.getElementById("areaBtn").addEventListener("click", () => {
    map.fitBounds(boundaryLayer.getBounds().pad(0.08));
  });
  document.getElementById("heatBtn").addEventListener("click", toggleHeatMode);
  document.getElementById("dispatcherBtn").addEventListener("click", toggleDispatcherMode);
  document.getElementById("exportBtn").addEventListener("click", exportState);
  document.getElementById("importBtn").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", importState);
}

function refreshModeButtons() {
  const heatBtn = document.getElementById("heatBtn");
  const dispatcherBtn = document.getElementById("dispatcherBtn");
  if (heatBtn) {
    heatBtn.textContent = heatMode ? "Status" : "Heat";
    heatBtn.classList.toggle("active", heatMode);
  }
  if (dispatcherBtn) {
    dispatcherBtn.textContent = state.profile.dispatcher ? "Exit dispatch" : "Dispatcher";
    dispatcherBtn.classList.toggle("active", state.profile.dispatcher);
  }
}

function toggleHeatMode() {
  heatMode = !heatMode;
  refreshGrid();
  refreshModeButtons();
  showToast(heatMode ? "Heat map shows audit activity." : "Status colors restored.");
}

function toggleDispatcherMode() {
  if (state.profile.dispatcher) {
    state.profile.dispatcher = false;
    state.profile.role = "volunteer";
    dispatcherLoginOpen = false;
    addAudit("dispatcher_mode_exited", null, {});
    saveState();
    refreshModeButtons();
    renderPanel();
    showToast("Dispatcher mode off.");
    return;
  }

  dispatcherLoginOpen = true;
  activeCellId = null;
  refreshModeButtons();
  refreshGrid();
  renderPanel();
  requestAnimationFrame(() => {
    document.getElementById("dispatcherPin")?.focus();
  });
  showToast("Enter dispatcher PIN.");
}

function selectCell(id) {
  activeCellId = id;
  refreshGrid();
  renderPanel();
}

function renderPanel() {
  const panel = document.getElementById("panel");
  if (!activeCellId) {
    panel.innerHTML = renderCommandPanel();
    bindCommandPanel();
    return;
  }

  panel.innerHTML = renderCellPanel(activeCellId);
  bindCellPanel(activeCellId);
}

function renderCommandPanel() {
  const counts = getCounts();
  const analytics = getAnalytics(counts);
  const activity = getRecentActivity();
  return `
    <h2>Command Board</h2>
    <p class="muted tight">${cellFeatures.length} grid squares, ${GRID_CELL_KM} km each. Grid updates sync across phones; each volunteer identity stays on their own device.</p>
    <p class="sync-line ${sharedSyncStatus === "live" ? "live" : "offline"}">Shared sync: ${escapeHtml(sharedSyncStatus)}</p>
    <div class="summary-grid">
      ${summaryItem(counts.open, "Open")}
      ${summaryItem(counts.searching, "Searching")}
      ${summaryItem(counts.done, "Complete")}
      ${summaryItem(counts.backup + counts.emergency + counts.found, "Escalations")}
    </div>

    <div class="metric-grid">
      ${metricItem(`${analytics.coverage}%`, "Coverage")}
      ${metricItem(counts.stale, "Stale released")}
      ${metricItem(analytics.openIncidents, "Open incidents")}
      ${metricItem(analytics.volunteersSearching, "Volunteers out")}
    </div>

    <h3>Volunteer Identity</h3>
    <form id="profileForm" class="profile-form">
      <label>Name
        <input id="profileName" autocomplete="name" value="${escapeAttr(state.profile.name)}" />
      </label>
      <div class="field-row">
        <label>Phone
          <input id="profileContact" autocomplete="tel" value="${escapeAttr(state.profile.contact)}" />
        </label>
        <label>Team
          <input id="profileTeam" value="${escapeAttr(state.profile.team)}" />
        </label>
      </div>
      <div class="button-row">
        <button class="button full" type="submit">Save identity</button>
      </div>
    </form>

    <div class="identity-card">
      <span class="role-pill ${state.profile.phoneVerified ? "verified" : ""}">
        ${state.profile.phoneVerified ? "Phone verified" : "Phone unverified"}
      </span>
      <span class="role-pill">${escapeHtml(state.profile.role)}</span>
      <span class="small">Session ${shortId(session.id)}</span>
    </div>

    <div class="verification-row">
      <button id="sendCodeBtn" class="button" type="button">Send demo code</button>
      <label>Code
        <input id="phoneCode" inputmode="numeric" autocomplete="one-time-code" />
      </label>
      <button id="verifyCodeBtn" class="button success" type="button">Verify</button>
    </div>
    ${
      state.profile.verificationCode
        ? `<p class="notice warning">Demo code: <strong>${escapeHtml(
            state.profile.verificationCode,
          )}</strong>. Real SMS verification needs a backend.</p>`
        : ""
    }

    ${dispatcherLoginOpen && !state.profile.dispatcher ? renderDispatcherLogin() : ""}
    ${state.profile.dispatcher ? renderDispatcherDashboard() : ""}

    <div class="divider"></div>
    <h3>Recent Updates</h3>
    ${renderActivity(activity)}
  `;
}

function renderDispatcherLogin() {
  return `
    <div class="divider"></div>
    <h3>Dispatcher Login</h3>
    <form id="dispatcherLoginForm" class="verification-row dispatcher-login">
      <label>PIN
        <input id="dispatcherPin" inputmode="numeric" autocomplete="off" />
      </label>
      <button id="dispatcherLoginBtn" class="button active" type="submit">Enter dispatch</button>
    </form>
  `;
}

function renderLocationKeyControl() {
  const unlocked = Boolean(positionsKey);
  return `
    <h3>Live volunteer map</h3>
    <p class="muted tight">Volunteer GPS locations are private. Enter the dispatcher location key to show them on the map.</p>
    <div class="verification-row">
      <label>Location key
        <input id="positionsKeyInput" type="password" autocomplete="off" value="${escapeAttr(
          positionsKey,
        )}" />
      </label>
      <button id="positionsKeyBtn" class="button active" type="button">${
        unlocked ? "Update" : "Unlock"
      }</button>
    </div>
    ${
      unlocked
        ? '<p class="notice success">Location feed unlocked on this device.</p>'
        : ""
    }
  `;
}

function renderDispatcherDashboard() {
  const staleCells = getCellsByStatus("stale");
  const activeCells = getCellsByStatus("searching");
  const incidents = getOpenIncidents();
  const audit = state.audit.slice(-12).reverse();
  return `
    <section id="dispatcherDashboard" class="dispatcher-dashboard" tabindex="-1" aria-live="polite">
      <div class="divider"></div>
      <h3>Dispatcher</h3>
      <p class="notice success"><strong>Dispatcher mode active.</strong> The PIN field closes after login. Use the top button to exit dispatch mode.</p>
      ${renderLocationKeyControl()}
      <div class="button-row">
        <button id="runStaleBtn" class="button warning" type="button">Run stale release</button>
        <button id="exportAuditBtn" class="button" type="button">Export audit</button>
      </div>
      <div class="dashboard-strip">
        ${dashboardList("Active", activeCells)}
        ${dashboardList("Stale", staleCells)}
      </div>
      <h3>Incident Log</h3>
      ${renderIncidentList(incidents)}
      <h3>Audit Trail</h3>
      ${renderAuditLog(audit)}
    </section>
  `;
}

function renderCellPanel(id) {
  const entry = state.cells[id] || {};
  const statusKey = entry.status || "open";
  const status = STATUS[statusKey] || STATUS.open;
  const activeIncident = getOpenIncidentForGrid(id);
  const searchers = getSearchers(entry);
  const heartbeatAge = entry.lastHeartbeatAt
    ? formatRelativeAge(entry.lastHeartbeatAt)
    : "None";
  const staleEta = entry.status === "searching" ? getStaleEta(entry) : "";
  const name = state.profile.name || "";
  const contact = state.profile.contact || "";
  const team = state.profile.team || "";
  const notes = entry.notes ?? "";

  return `
    <button id="backBtn" class="button" type="button">Back</button>
    <h2 style="margin-top: 16px;">Grid ${id}</h2>
    <span class="status-pill ${status.className}">${status.label}</span>
    ${
      activeIncident
        ? `<p class="notice danger"><strong>${escapeHtml(
            activeIncident.type,
          )}</strong>: ${escapeHtml(activeIncident.route)}</p>`
        : ""
    }

    ${renderSearcherList(searchers)}

    <dl class="meta-list">
      ${metaRow("People searching", String(searchers.length))}
      ${metaRow("Updated", entry.updatedAt ? formatTime(entry.updatedAt) : "Never")}
      ${metaRow("Last heartbeat", heartbeatAge)}
      ${staleEta ? metaRow("Auto-release", staleEta) : ""}
    </dl>

    <form id="cellForm" class="cell-form">
      <label>Your name
        <input id="cellName" autocomplete="name" value="${escapeAttr(name)}" />
      </label>
      <div class="field-row">
        <label>Your phone
          <input id="cellContact" autocomplete="tel" value="${escapeAttr(contact)}" />
        </label>
        <label>Your team
          <input id="cellTeam" value="${escapeAttr(team)}" />
        </label>
      </div>
      <label>Notes
        <textarea id="cellNotes">${escapeHtml(notes)}</textarea>
      </label>
    </form>

    <h3>Status</h3>
    <div class="status-grid">
      <button class="button primary" data-status="searching" type="button">Keep searching</button>
      <button class="button success" data-status="done" type="button">Search complete</button>
      <button class="button" data-status="stopped" type="button">Stopped</button>
      <button class="button warning" data-status="backup" type="button">Need backup</button>
      <button class="button danger" data-status="emergency" type="button">Emergency</button>
      <button class="button danger" data-status="found" type="button">Found Esti</button>
    </div>
    <div class="button-row stack-space">
      <button id="heartbeatBtn" class="button full" type="button">Send heartbeat</button>
      ${
        state.profile.dispatcher || isOwnedByCurrentUser(entry)
          ? '<button id="releaseCellBtn" class="button warning full" type="button">Release grid</button>'
          : ""
      }
      ${
        state.profile.dispatcher && activeIncident
          ? '<button id="resolveIncidentBtn" class="button success full" type="button">Resolve incident</button>'
          : ""
      }
    </div>
  `;
}

function bindCommandPanel() {
  document.getElementById("profileForm").addEventListener("submit", (event) => {
    event.preventDefault();
    saveProfileFromCommand();
  });
  document.getElementById("sendCodeBtn").addEventListener("click", sendVerificationCode);
  document.getElementById("verifyCodeBtn").addEventListener("click", verifyPhoneCode);

  const runStaleBtn = document.getElementById("runStaleBtn");
  if (runStaleBtn) {
    runStaleBtn.addEventListener("click", () => scanStaleCells({ manual: true }));
  }

  const exportAuditBtn = document.getElementById("exportAuditBtn");
  if (exportAuditBtn) {
    exportAuditBtn.addEventListener("click", exportAudit);
  }

  const positionsKeyBtn = document.getElementById("positionsKeyBtn");
  if (positionsKeyBtn) {
    positionsKeyBtn.addEventListener("click", savePositionsKey);
  }

  const dispatcherLoginForm = document.getElementById("dispatcherLoginForm");
  if (dispatcherLoginForm) {
    dispatcherLoginForm.addEventListener("submit", enterDispatcherMode);
  }

  document.querySelectorAll("[data-jump-grid]").forEach((button) => {
    button.addEventListener("click", () => selectCell(button.dataset.jumpGrid));
  });
}

function enterDispatcherMode(event) {
  event?.preventDefault();
  const pin = document.getElementById("dispatcherPin").value.trim();
  if (pin !== DISPATCHER_PIN) {
    addAudit("dispatcher_login_failed", null, {});
    saveState();
    showToast("Dispatcher PIN rejected.");
    return;
  }

  dispatcherLoginOpen = false;
  state.profile.dispatcher = true;
  state.profile.role = "dispatcher";
  addAudit("dispatcher_mode_enabled", null, {});
  saveState();
  refreshModeButtons();
  renderPanel();
  requestAnimationFrame(() => {
    const dashboard = document.getElementById("dispatcherDashboard");
    dashboard?.scrollIntoView({ block: "start", behavior: "smooth" });
    dashboard?.focus({ preventScroll: true });
  });
  showToast("Dispatcher mode on. Dashboard is open.");
}


function bindCellPanel(id) {
  document.getElementById("backBtn").addEventListener("click", () => {
    activeCellId = null;
    refreshGrid();
    renderPanel();
  });

  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", () => updateCell(id, button.dataset.status));
  });

  document.getElementById("heartbeatBtn").addEventListener("click", () => {
    sendHeartbeat(id);
  });

  const releaseCellBtn = document.getElementById("releaseCellBtn");
  if (releaseCellBtn) {
    releaseCellBtn.addEventListener("click", () => releaseCell(id, "manual_release"));
  }

  const resolveIncidentBtn = document.getElementById("resolveIncidentBtn");
  if (resolveIncidentBtn) {
    resolveIncidentBtn.addEventListener("click", () => resolveIncidentForGrid(id));
  }
}

function saveProfileFromCommand() {
  const previousContact = state.profile.contact;
  const nextContact = document.getElementById("profileContact").value.trim();
  state.profile.name = document.getElementById("profileName").value.trim();
  state.profile.contact = nextContact;
  state.profile.team = document.getElementById("profileTeam").value.trim();
  state.profile.lastSeenAt = new Date().toISOString();

  if (previousContact !== nextContact) {
    state.profile.phoneVerified = false;
    state.profile.verifiedAt = "";
    state.profile.verificationCode = "";
    state.profile.verificationSentAt = "";
  }

  addAudit("identity_updated", null, {
    phoneVerified: state.profile.phoneVerified,
  });
  saveState();
  renderPanel();
  showToast("Identity saved.");
}

function saveProfileFromCellForm() {
  const previousContact = state.profile.contact;
  const name = document.getElementById("cellName").value.trim();
  const contact = document.getElementById("cellContact").value.trim();
  const team = document.getElementById("cellTeam").value.trim();

  state.profile.name = name;
  state.profile.contact = contact;
  state.profile.team = team;
  state.profile.lastSeenAt = new Date().toISOString();

  if (previousContact !== contact) {
    state.profile.phoneVerified = false;
    state.profile.verifiedAt = "";
    state.profile.verificationCode = "";
    state.profile.verificationSentAt = "";
  }

  return { name, contact, team };
}

function sendVerificationCode() {
  const phone = document.getElementById("profileContact").value.trim();
  if (!phone) {
    showToast("Enter a phone number first.");
    return;
  }

  state.profile.name = document.getElementById("profileName").value.trim();
  state.profile.contact = phone;
  state.profile.team = document.getElementById("profileTeam").value.trim();
  state.profile.verificationCode = String(Math.floor(100000 + Math.random() * 900000));
  state.profile.verificationSentAt = new Date().toISOString();
  state.profile.phoneVerified = false;
  state.profile.verifiedAt = "";
  addAudit("phone_verification_requested", null, {
    phone: maskPhone(phone),
    mode: "demo_local_code",
  });
  saveState();
  renderPanel();
  showToast("Demo code generated.");
}

function verifyPhoneCode() {
  const code = document.getElementById("phoneCode").value.trim();
  if (!state.profile.verificationCode || code !== state.profile.verificationCode) {
    addAudit("phone_verification_failed", null, {
      phone: maskPhone(state.profile.contact),
    });
    saveState();
    showToast("Verification code did not match.");
    return;
  }

  state.profile.phoneVerified = true;
  state.profile.verifiedAt = new Date().toISOString();
  state.profile.verificationCode = "";
  state.profile.verificationSentAt = "";
  addAudit("phone_verified", null, {
    phone: maskPhone(state.profile.contact),
  });
  saveState();
  renderPanel();
  showToast("Phone marked verified.");
}

function updateCell(id, status) {
  const existing = state.cells[id] || {};
  const actorFields = saveProfileFromCellForm();
  const notes = document.getElementById("cellNotes").value.trim();
  const now = new Date().toISOString();
  const previousStatus = existing.status || "open";
  const searchers = getSearchers(existing).map((entry) => ({ ...entry }));
  const myIndex = findSearcherIndex(existing);
  const me = {
    userId: state.profile.userId,
    sessionId: session.id,
    name: actorFields.name,
    contact: actorFields.contact,
    team: actorFields.team,
    phoneVerified: state.profile.phoneVerified,
  };

  let nextStatus = status;
  let toastMessage = `Grid ${id}: ${STATUS[status].label}.`;

  if (status === "searching") {
    // Joining a grid never blocks; multiple volunteers may search together.
    if (myIndex === -1) {
      searchers.push({ ...me, joinedAt: now, lastHeartbeatAt: now });
    } else {
      searchers[myIndex] = { ...searchers[myIndex], ...me, lastHeartbeatAt: now };
    }
    nextStatus = "searching";
    toastMessage = `Grid ${id}: you are searching here (${searchers.length} on this grid).`;
  } else if (status === "done" || status === "stopped") {
    // Completing or stopping removes only this volunteer; the grid closes
    // only once the last searcher leaves.
    if (myIndex !== -1) {
      searchers.splice(myIndex, 1);
    }
    if (searchers.length > 0) {
      nextStatus = "searching";
      toastMessage = `Grid ${id}: you left. ${searchers.length} still searching here.`;
    } else {
      nextStatus = status;
    }
  } else {
    // Escalations (backup / emergency / found) apply to the whole grid.
    nextStatus = status;
  }

  state.cells[id] = {
    ...existing,
    id,
    status: nextStatus,
    searchers,
    name: actorFields.name,
    contact: actorFields.contact,
    team: actorFields.team,
    userId: state.profile.userId,
    sessionId: session.id,
    phoneVerified: state.profile.phoneVerified,
    notes,
    updatedAt: now,
    createdAt: existing.createdAt || now,
    assignedAt:
      nextStatus === "searching" ? existing.assignedAt || now : existing.assignedAt || "",
    lastHeartbeatAt:
      nextStatus === "searching"
        ? latestHeartbeatOf(searchers) || now
        : existing.lastHeartbeatAt || "",
    lastActionBy: currentActor(),
    lastReleaseReason: "",
  };

  if (nextStatus === "searching" && previousStatus === "stale") {
    state.cells[id].reclaimedAt = now;
  }

  if (ESCALATION_STATUSES.has(nextStatus)) {
    createIncident(id, nextStatus, notes);
  }

  if (CLOSED_STATUSES.has(nextStatus)) {
    resolveIncidentsForGrid(id, `Closed by ${nextStatus}`);
  }

  addAudit(actionTypeForStatus(status), id, {
    status: nextStatus,
    requestedStatus: status,
    previousStatus,
    notes,
    searcherCount: searchers.length,
    phoneVerified: state.profile.phoneVerified,
  });
  saveState();
  refreshGrid();
  renderPanel();
  showToast(toastMessage);
}

function sendHeartbeat(id) {
  const cell = state.cells[id];
  if (!cell || cell.status !== "searching") {
    showToast("Heartbeat only applies to an active search grid.");
    return;
  }
  const myIndex = findSearcherIndex(cell);
  if (myIndex === -1) {
    showToast('Tap "Keep searching" to join this grid first.');
    return;
  }

  const now = new Date().toISOString();
  const searchers = getSearchers(cell).map((entry) => ({ ...entry }));
  searchers[myIndex] = { ...searchers[myIndex], lastHeartbeatAt: now };
  cell.searchers = searchers;
  cell.lastHeartbeatAt = latestHeartbeatOf(searchers) || now;
  cell.updatedAt = now;
  cell.lastActionBy = currentActor();
  addAudit("heartbeat", id, {
    searcherCount: searchers.length,
  });
  saveState();
  renderPanel();
  showToast(`Grid ${id} heartbeat recorded.`);
}

function releaseCell(id, reason) {
  const cell = state.cells[id];
  if (!cell) {
    showToast(`Grid ${id} is already open.`);
    return;
  }
  const myIndex = findSearcherIndex(cell);
  if (!state.profile.dispatcher && myIndex === -1) {
    addAudit("release_blocked", id, {
      releasedSearchers: ownerSnapshot(cell),
      reason,
    });
    saveState();
    showToast("Only a volunteer searching this grid or dispatcher can release it.");
    return;
  }

  const now = new Date().toISOString();
  const previousStatus = cell.status || "open";

  // A volunteer releasing only leaves the grid; anyone else keeps searching.
  if (!state.profile.dispatcher && myIndex !== -1) {
    const searchers = getSearchers(cell)
      .map((entry) => ({ ...entry }))
      .filter((_, index) => index !== myIndex);
    if (searchers.length > 0) {
      state.cells[id] = {
        ...cell,
        searchers,
        status: "searching",
        updatedAt: now,
        lastHeartbeatAt: latestHeartbeatOf(searchers),
        lastActionBy: currentActor(),
      };
      addAudit("volunteer_left_grid", id, {
        previousStatus,
        searcherCount: searchers.length,
      });
      saveState();
      refreshGrid();
      renderPanel();
      showToast(`Grid ${id}: you left. ${searchers.length} still searching here.`);
      return;
    }
  }

  // Dispatcher release, or the last searcher leaving: the grid goes stale.
  state.cells[id] = {
    ...cell,
    searchers: [],
    status: "stale",
    updatedAt: now,
    staleReleasedAt: now,
    lastReleaseReason: reason,
    lastActionBy: currentActor(),
  };
  addAudit(reason, id, {
    previousStatus,
    releasedSearchers: ownerSnapshot(cell),
  });
  saveState();
  refreshGrid();
  renderPanel();
  showToast(`Grid ${id} released.`);
}

function scanStaleCells(options = {}) {
  const now = new Date();
  let released = 0;
  let removedSearchers = 0;

  Object.entries(state.cells).forEach(([id, cell]) => {
    if (cell.status !== "searching") {
      return;
    }
    const searchers = getSearchers(cell);
    const fresh = searchers.filter((entry) => {
      const last = entry.lastHeartbeatAt || entry.joinedAt;
      return last && minutesSince(last, now) < STALE_AFTER_MINUTES;
    });
    if (fresh.length === searchers.length) {
      return;
    }

    removedSearchers += searchers.length - fresh.length;
    const previousStatus = cell.status;

    if (fresh.length > 0) {
      // Some volunteers are still active: drop only the stale ones.
      state.cells[id] = {
        ...cell,
        searchers: fresh,
        updatedAt: now.toISOString(),
        lastHeartbeatAt: latestHeartbeatOf(fresh),
        lastActionBy: systemActor(),
      };
      addAudit(
        "stale_searcher_removed",
        id,
        {
          removed: searchers.length - fresh.length,
          searcherCount: fresh.length,
        },
        systemActor(),
      );
    } else {
      // The last active volunteer went stale: release the whole grid.
      state.cells[id] = {
        ...cell,
        searchers: [],
        status: "stale",
        updatedAt: now.toISOString(),
        staleReleasedAt: now.toISOString(),
        lastReleaseReason: `No heartbeat for ${STALE_AFTER_MINUTES} minutes`,
        lastActionBy: systemActor(),
      };
      addAudit(
        "auto_release_stale",
        id,
        {
          previousStatus,
          releasedSearchers: ownerSnapshot(cell),
        },
        systemActor(),
      );
      released += 1;
    }
  });

  if (released || removedSearchers) {
    saveState();
    refreshGrid();
    renderPanel();
  }

  if (options.manual) {
    addAudit("stale_release_scan", null, { released, removedSearchers });
    saveState();
    renderPanel();
    showToast(released ? `${released} stale grid released.` : "No stale grids found.");
  } else if (released && !options.silent) {
    showToast(`${released} stale grid released.`);
  }

  return released;
}

function refreshGrid() {
  if (gridLayer) {
    gridLayer.setStyle(getCellStyle);
  }
  if (map && labelLayer) {
    renderLabels();
  }
}

function getCounts() {
  const counts = {
    open: cellFeatures.length,
    searching: 0,
    done: 0,
    stopped: 0,
    backup: 0,
    emergency: 0,
    found: 0,
    stale: 0,
  };

  Object.values(state.cells).forEach((cell) => {
    if (!cell.status || !Object.prototype.hasOwnProperty.call(counts, cell.status)) {
      return;
    }
    counts.open -= 1;
    counts[cell.status] += 1;
  });

  return counts;
}

function getAnalytics(counts = getCounts()) {
  const covered = counts.done + counts.stopped + counts.found;
  const volunteersSearching = Object.values(state.cells).reduce(
    (total, cell) => total + searcherCount(cell),
    0,
  );

  return {
    coverage: Math.round((covered / cellFeatures.length) * 100),
    openIncidents: getOpenIncidents().length,
    volunteersSearching,
  };
}

function getRecentActivity() {
  return state.audit
    .filter((event) => event.grid)
    .slice(-8)
    .reverse();
}

function getCellsByStatus(status) {
  return Object.values(state.cells)
    .filter((cell) => cell.status === status)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function summaryItem(count, label) {
  return `<div class="summary-item"><strong>${count}</strong><span>${label}</span></div>`;
}

function metricItem(value, label) {
  return `<div class="metric-item"><strong>${escapeHtml(value)}</strong><span>${label}</span></div>`;
}

function dashboardList(label, cells) {
  return `
    <div class="dashboard-list">
      <strong>${label}</strong>
      ${
        cells.length
          ? `<ul>${cells
              .slice(0, 6)
              .map(
                (cell) =>
                  `<li><button class="link-button" type="button" data-jump-grid="${escapeAttr(
                    cell.id,
                  )}">${escapeHtml(cell.id)}</button> ${escapeHtml(
                    cell.name || "unassigned",
                  )}</li>`,
              )
              .join("")}</ul>`
          : '<p class="muted">None</p>'
      }
    </div>
  `;
}

function renderActivity(activity) {
  if (!activity.length) {
    return '<p class="muted">No grid updates yet.</p>';
  }

  return `
    <ul class="activity-list">
      ${activity
        .map(
          (event) => `
            <li>
              <strong>${escapeHtml(event.grid)}</strong>
              ${escapeHtml(humanAction(event.actionType))}
              ${event.user?.name ? `by ${escapeHtml(event.user.name)}` : ""}
              <br />
              ${formatTime(event.timestamp)}
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderIncidentList(incidents) {
  if (!incidents.length) {
    return '<p class="muted">No open incidents.</p>';
  }

  return `
    <ul class="incident-list">
      ${incidents
        .map(
          (incident) => `
            <li>
              <strong>${escapeHtml(incident.grid)} ${escapeHtml(incident.type)}</strong>
              <span>${escapeHtml(incident.route)}</span>
              <small>${formatTime(incident.createdAt)} by ${escapeHtml(
                incident.createdBy?.name || "unknown",
              )}</small>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderAuditLog(audit) {
  if (!audit.length) {
    return '<p class="muted">No audit events yet.</p>';
  }

  return `
    <ul class="audit-list">
      ${audit
        .map(
          (event) => `
            <li>
              <strong>${escapeHtml(humanAction(event.actionType))}</strong>
              ${event.grid ? `grid ${escapeHtml(event.grid)}` : "system"}
              <small>${formatTime(event.timestamp)} / ${escapeHtml(
                event.user?.name || event.user?.userId || "system",
              )}</small>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderSearcherList(searchers) {
  if (!searchers.length) {
    return '<p class="notice">No volunteers on this grid yet. Tap "Keep searching" below to start.</p>';
  }
  const noun = searchers.length === 1 ? "person" : "people";
  return `
    <div class="searcher-block">
      <p class="searcher-count">${searchers.length} ${noun} searching here</p>
      <ul class="searcher-list">
        ${searchers
          .map((entry) => {
            const isMe =
              (entry.userId && entry.userId === state.profile.userId) ||
              (entry.sessionId && entry.sessionId === session.id);
            return `<li>
              <strong>${escapeHtml(entry.name || "Volunteer")}</strong>${
                isMe ? ' <span class="you-pill">you</span>' : ""
              }
              ${entry.team ? `<span class="small">${escapeHtml(entry.team)}</span>` : ""}
            </li>`;
          })
          .join("")}
      </ul>
    </div>
  `;
}

function metaRow(label, value) {
  return `<div class="meta-row"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function createIncident(grid, status, notes) {
  const existing = getOpenIncidentForGrid(grid);
  const now = new Date().toISOString();
  const incident = {
    id: existing?.id || makeId("inc"),
    grid,
    type: STATUS[status]?.label || status,
    status: "open",
    severity: status === "backup" ? "moderate" : "critical",
    route: routeForStatus(status),
    notes,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || currentActor(),
    updatedBy: currentActor(),
  };

  if (existing) {
    Object.assign(existing, incident);
    addAudit("incident_updated", grid, {
      incidentId: incident.id,
      type: incident.type,
      route: incident.route,
    });
  } else {
    state.incidents.push(incident);
    addAudit("incident_created", grid, {
      incidentId: incident.id,
      type: incident.type,
      route: incident.route,
    });
  }
}

function resolveIncidentForGrid(grid) {
  const incident = getOpenIncidentForGrid(grid);
  if (!incident) {
    showToast("No open incident for this grid.");
    return;
  }
  incident.status = "resolved";
  incident.resolvedAt = new Date().toISOString();
  incident.resolvedBy = currentActor();
  addAudit("incident_resolved", grid, {
    incidentId: incident.id,
  });
  saveState();
  renderPanel();
  showToast(`Incident for ${grid} resolved.`);
}

function resolveIncidentsForGrid(grid, reason) {
  getOpenIncidents()
    .filter((incident) => incident.grid === grid)
    .forEach((incident) => {
      incident.status = "resolved";
      incident.resolvedAt = new Date().toISOString();
      incident.resolvedBy = currentActor();
      incident.resolutionReason = reason;
      addAudit("incident_auto_resolved", grid, {
        incidentId: incident.id,
        reason,
      });
    });
}

function getOpenIncidentForGrid(grid) {
  return state.incidents.find(
    (incident) => incident.grid === grid && incident.status === "open",
  );
}

function getOpenIncidents() {
  return state.incidents.filter((incident) => incident.status === "open");
}

function routeForStatus(status) {
  if (status === "backup") {
    return "Dispatcher review, assign nearby team.";
  }
  if (status === "found") {
    return "Hold location, notify command lead and emergency services.";
  }
  return "Immediate dispatcher escalation, call emergency services if there is danger.";
}

function addAudit(actionType, grid, details, actor = currentActor()) {
  const event = {
    id: makeId("evt"),
    timestamp: new Date().toISOString(),
    user: actor,
    grid,
    actionType,
    details: details || {},
  };
  state.audit.push(event);
  if (state.audit.length > 1000) {
    state.audit = state.audit.slice(-1000);
  }
  return event;
}

function currentActor() {
  return {
    userId: state.profile.userId || "unknown",
    sessionId: session.id,
    name: state.profile.name || "",
    phone: maskPhone(state.profile.contact),
    team: state.profile.team || "",
    role: state.profile.role || "volunteer",
    phoneVerified: Boolean(state.profile.phoneVerified),
  };
}

function systemActor() {
  return {
    userId: "system",
    sessionId: "system",
    name: "System",
    phone: "",
    team: "",
    role: "system",
    phoneVerified: false,
  };
}

function ownerSnapshot(cell) {
  const searchers = getSearchers(cell);
  return {
    searcherCount: searchers.length,
    searchers: searchers.map((entry) => ({
      userId: entry.userId || "",
      name: entry.name || "",
      phone: maskPhone(entry.contact || ""),
      team: entry.team || "",
      phoneVerified: Boolean(entry.phoneVerified),
    })),
  };
}

function actionTypeForStatus(status) {
  return (
    {
      searching: "claim_or_continue_search",
      done: "search_completed",
      stopped: "search_stopped",
      backup: "backup_requested",
      emergency: "emergency_reported",
      found: "found_reported",
    }[status] || "status_updated"
  );
}

function humanAction(actionType) {
  return actionType.replaceAll("_", " ");
}

function getSearchers(cell) {
  return Array.isArray(cell?.searchers) ? cell.searchers : [];
}

function searcherCount(cell) {
  return getSearchers(cell).length;
}

function findSearcherIndex(cell) {
  return getSearchers(cell).findIndex(
    (entry) =>
      (entry.userId && entry.userId === state.profile.userId) ||
      (entry.sessionId && entry.sessionId === session.id),
  );
}

function isCurrentUserSearching(cell) {
  return findSearcherIndex(cell) !== -1;
}

function isOwnedByCurrentUser(cell) {
  return isCurrentUserSearching(cell);
}

function latestHeartbeatOf(searchers) {
  return searchers
    .map((entry) => entry.lastHeartbeatAt || entry.joinedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function getStaleEta(cell) {
  const last = cell.lastHeartbeatAt || cell.updatedAt || cell.assignedAt;
  if (!last) {
    return `${STALE_AFTER_MINUTES} minutes without heartbeat`;
  }
  const age = minutesSince(last);
  const remaining = STALE_AFTER_MINUTES - age;
  if (remaining <= 0) {
    return "Due now";
  }
  if (age >= HEARTBEAT_WARNING_MINUTES) {
    return `${remaining} minutes remaining`;
  }
  return `${remaining} minutes`;
}

function minutesSince(value, now = new Date()) {
  return Math.max(0, Math.floor((now - new Date(value)) / 60000));
}

function formatRelativeAge(value) {
  const minutes = minutesSince(value);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes === 1) {
    return "1 minute ago";
  }
  return `${minutes} minutes ago`;
}

function getGridAuditCount(id) {
  return state.audit.filter((event) => event.grid === id).length;
}

function toggleGps() {
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    gpsCellId = null;
    lastGpsFix = null;
    didCenterGps = false;
    document.getElementById("locateBtn").textContent = "Locate me";
    updateGpsStatus("GPS stopped");
    refreshGrid();
    return;
  }

  if (!navigator.geolocation) {
    showToast("GPS is not available in this browser.");
    return;
  }

  updateGpsStatus("GPS starting...");
  document.getElementById("locateBtn").textContent = "Stop GPS";
  gpsWatchId = navigator.geolocation.watchPosition(handleGps, handleGpsError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 14000,
  });
}

function handleGps(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const latLng = [latitude, longitude];
  const firstFix = !lastGpsFix;
  lastGpsFix = { lat: latitude, lng: longitude, accuracy: accuracy || null };

  if (!gpsMarker) {
    gpsMarker = L.marker(latLng, {
      icon: L.divIcon({
        className: "",
        html: '<div class="user-location-dot"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    gpsMarker.setLatLng(latLng);
  }

  if (!gpsAccuracy) {
    gpsAccuracy = L.circle(latLng, {
      radius: accuracy || 0,
      color: "#6d28d9",
      weight: 1,
      fillColor: "#6d28d9",
      fillOpacity: 0.08,
    }).addTo(map);
  } else {
    gpsAccuracy.setLatLng(latLng).setRadius(accuracy || 0);
  }

  if (!didCenterGps) {
    map.setView(latLng, Math.max(map.getZoom(), 15));
    didCenterGps = true;
  }

  const newGpsCellId = findContainingCell(longitude, latitude);
  gpsCellId = newGpsCellId;
  refreshGrid();

  if (newGpsCellId) {
    const status = state.cells[newGpsCellId]?.status || "open";
    updateGpsStatus(
      `GPS: grid ${newGpsCellId}, ${STATUS[status].label.toLowerCase()}, accuracy ${Math.round(
        accuracy || 0,
      )} m`,
    );
  } else {
    updateGpsStatus(`GPS: outside search area, accuracy ${Math.round(accuracy || 0)} m`);
  }

  if (firstFix) {
    pushMyPosition();
  }
}

function handleGpsError(error) {
  document.getElementById("locateBtn").textContent = "Locate me";
  gpsWatchId = null;
  const message =
    error.code === error.PERMISSION_DENIED
      ? "GPS permission denied."
      : "GPS could not get a position.";
  updateGpsStatus(message);
  showToast(message);
}

function startPositionSync() {
  fetchVolunteerPositions();
  positionSyncTimer = window.setInterval(() => {
    pushMyPosition();
    fetchVolunteerPositions();
  }, POSITION_SYNC_MS);
}

async function pushMyPosition() {
  // Autoshare: whenever GPS is on, this phone broadcasts its location.
  if (gpsWatchId === null || !lastGpsFix) {
    return;
  }
  try {
    await fetch(POSITIONS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: state.profile.userId,
        name: state.profile.name || "Volunteer",
        team: state.profile.team || "",
        lat: lastGpsFix.lat,
        lng: lastGpsFix.lng,
        accuracy: lastGpsFix.accuracy,
      }),
    });
  } catch {
    // Position sharing is best-effort; ignore transient network failures.
  }
}

async function fetchVolunteerPositions() {
  // Volunteer locations are dispatcher-only: with no key, never fetch or draw.
  if (!positionsKey) {
    renderVolunteerMarkers([]);
    return;
  }
  try {
    const response = await fetch(`${POSITIONS_API}?t=${Date.now()}`, {
      cache: "no-store",
      headers: { "x-positions-key": positionsKey },
    });
    if (!response.ok) {
      if (response.status === 403) {
        renderVolunteerMarkers([]);
      }
      return;
    }
    const payload = await response.json();
    renderVolunteerMarkers(Array.isArray(payload.positions) ? payload.positions : []);
  } catch {
    // Keep the last drawn markers if a refresh fails.
  }
}

async function savePositionsKey() {
  const value = document.getElementById("positionsKeyInput").value.trim();
  positionsKey = value;
  if (!value) {
    localStorage.removeItem(POSITIONS_KEY_STORE);
    renderVolunteerMarkers([]);
    renderPanel();
    showToast("Location key cleared.");
    return;
  }
  localStorage.setItem(POSITIONS_KEY_STORE, value);
  try {
    const response = await fetch(`${POSITIONS_API}?t=${Date.now()}`, {
      cache: "no-store",
      headers: { "x-positions-key": value },
    });
    if (response.ok) {
      const payload = await response.json();
      renderVolunteerMarkers(Array.isArray(payload.positions) ? payload.positions : []);
      showToast("Location feed unlocked.");
    } else {
      renderVolunteerMarkers([]);
      showToast("Location key was rejected.");
    }
  } catch {
    showToast("Could not reach the location feed.");
  }
  renderPanel();
}

function renderVolunteerMarkers(positions) {
  if (!volunteerLayer) {
    return;
  }
  volunteerLayer.clearLayers();
  const now = Date.now();
  positions.forEach((position) => {
    if (!position || position.userId === state.profile.userId) {
      return;
    }
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
      return;
    }
    if (
      typeof position.updatedAt === "number" &&
      now - position.updatedAt > POSITION_IDLE_MS
    ) {
      return;
    }
    const name = escapeHtml(position.name || "Volunteer");
    const marker = L.marker([position.lat, position.lng], {
      interactive: false,
      icon: L.divIcon({
        className: "volunteer-marker",
        html: `<span class="volunteer-dot"></span><span class="volunteer-name">${name}</span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
      zIndexOffset: 800,
    });
    volunteerLayer.addLayer(marker);
  });
}

function findContainingCell(lng, lat) {
  const point = turf.point([lng, lat]);
  for (const feature of cellFeatures) {
    if (turf.booleanPointInPolygon(point, feature)) {
      return feature.properties.id;
    }
  }
  return null;
}

function updateGpsStatus(message) {
  document.getElementById("gpsStatus").textContent = message;
}

function exportState() {
  const payload = {
    exportedAt: new Date().toISOString(),
    area: SEARCH_AREA,
    config: {
      staleAfterMinutes: STALE_AFTER_MINUTES,
      phoneVerificationMode: "demo_local_code",
    },
    cells: state.cells,
    audit: state.audit,
    incidents: state.incidents,
  };
  downloadJson(payload, `toronto-search-grid-${new Date().toISOString().slice(0, 10)}.json`);
  addAudit("state_exported", null, {
    cellCount: Object.keys(state.cells).length,
    auditCount: state.audit.length,
  });
  saveState();
  showToast("Search grid exported.");
}

function exportAudit() {
  const payload = {
    exportedAt: new Date().toISOString(),
    audit: state.audit,
    incidents: state.incidents,
  };
  downloadJson(payload, `toronto-search-audit-${new Date().toISOString().slice(0, 10)}.json`);
  addAudit("audit_exported", null, {
    auditCount: state.audit.length,
    incidentCount: state.incidents.length,
  });
  saveState();
  renderPanel();
  showToast("Audit exported.");
}

function downloadJson(payload, fileName) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function importState(event) {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  try {
    const imported = JSON.parse(await file.text());
    if (!imported.cells || typeof imported.cells !== "object") {
      throw new Error("Missing cells");
    }
    state.cells = normalizeCells(imported.cells);
    state.audit = Array.isArray(imported.audit) ? imported.audit : state.audit;
    state.incidents = Array.isArray(imported.incidents)
      ? imported.incidents
      : state.incidents;
    activeCellId = null;
    addAudit("state_imported", null, {
      cellCount: Object.keys(state.cells).length,
      auditCount: state.audit.length,
      incidentCount: state.incidents.length,
    });
    saveState();
    refreshGrid();
    renderPanel();
    showToast("Search grid imported.");
  } catch {
    showToast("Could not import that file.");
  } finally {
    event.target.value = "";
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function formatTime(value) {
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function makeId(prefix) {
  const random =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function shortId(value) {
  return String(value || "").split("-").at(-1)?.slice(0, 8) || "unknown";
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) {
    return digits ? "****" : "";
  }
  return `***-***-${digits.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
