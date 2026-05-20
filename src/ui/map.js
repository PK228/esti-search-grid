import { SEARCH_AREA, SEARCH_AREA_EXTENDED, KOESTER_DISTANCES, SEARCH_ID } from "../core/constants.js";
import { state, saveState } from "../core/state.js";
import { store } from "../core/store.js";
import { buildExtendedGrid } from "../grid/builder.js";
import { addAudit } from "../core/audit.js";
import { getCellStyle, renderLabels, refreshGrid } from "../grid/renderer.js";
import { escapeHtml, escapeAttr, formatLastSeenTime, toLocalDatetimeValue } from "../utils/format.js";
import { showToast } from "../utils/toast.js";

// ---- Boundary tracing tool ----
let _traceVertices = [];
let _tracePolyline = null;
let _traceMarkers = [];
let _traceControl = null;

export function startTraceBoundary() {
  store.traceBoundaryMode = true;
  _traceVertices = [];
  _traceMarkers = [];
  _tracePolyline = L.polyline([], { color: "#f59e0b", weight: 2.5, dashArray: "6,4" }).addTo(store.map);
  store.map.getContainer().style.cursor = "crosshair";

  const TraceCtrl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create("div", "leaflet-trace-control");
      div.innerHTML = `<span class="trace-count">0 pts</span>
        <button class="trace-btn trace-undo">Undo</button>
        <button class="trace-btn trace-done">Done</button>
        <button class="trace-btn trace-cancel">Cancel</button>`;
      L.DomEvent.on(div.querySelector(".trace-undo"),  "click", (e) => { L.DomEvent.stopPropagation(e); undoTraceVertex(); });
      L.DomEvent.on(div.querySelector(".trace-done"),  "click", (e) => { L.DomEvent.stopPropagation(e); finishTraceBoundary(); });
      L.DomEvent.on(div.querySelector(".trace-cancel"),"click", (e) => { L.DomEvent.stopPropagation(e); cancelTraceBoundary(); });
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  _traceControl = new TraceCtrl({ position: "bottomleft" });
  _traceControl.addTo(store.map);
}

export function undoTraceVertex() {
  if (!_traceVertices.length) return;
  _traceVertices.pop();
  const m = _traceMarkers.pop();
  if (m) store.map.removeLayer(m);
  _tracePolyline.setLatLngs(_traceVertices);
  if (_traceControl) _traceControl.getContainer().querySelector(".trace-count").textContent = `${_traceVertices.length} pts`;
}

export function finishTraceBoundary() {
  if (_traceVertices.length < 3) { showToast("Need at least 3 points."); return; }
  const closed = [..._traceVertices, _traceVertices[0]];
  const coords = closed.map(([lat, lng]) => [
    Math.round(lng * 100000) / 100000,
    Math.round(lat * 100000) / 100000,
  ]);

  // Persist the new boundary.
  state.customExtendedBoundary = coords;
  saveState();

  // Replace the boundary outline layer.
  if (store.extBoundaryLayer) store.map.removeLayer(store.extBoundaryLayer);
  store.extBoundaryLayer = L.polygon(coords.map(([lng, lat]) => [lat, lng]), {
    color: "#111827",
    weight: 3,
    opacity: 0.95,
    fill: false,
  }).addTo(store.map);

  // Rebuild extended grid cells and refresh.
  try {
    buildExtendedGrid();
    refreshGrid();
    showToast("Boundary saved — extended grid updated.");
  } catch (err) {
    console.error("buildExtendedGrid failed:", err);
    showToast("Boundary saved, but grid rebuild failed. Try a simpler boundary.");
  }
  cancelTraceBoundary();
}

export function cancelTraceBoundary() {
  store.traceBoundaryMode = false;
  if (_tracePolyline) { store.map.removeLayer(_tracePolyline); _tracePolyline = null; }
  _traceMarkers.forEach((m) => store.map.removeLayer(m));
  _traceMarkers = [];
  _traceVertices = [];
  if (_traceControl) { store.map.removeControl(_traceControl); _traceControl = null; }
  store.map.getContainer().style.cursor = "";
  document.dispatchEvent(new CustomEvent("esti:mode-buttons-changed"));
}

function _addTraceVertex(latlng) {
  _traceVertices.push([latlng.lat, latlng.lng]);
  _traceMarkers.push(
    L.circleMarker([latlng.lat, latlng.lng], { radius: 5, color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 1, weight: 2 }).addTo(store.map),
  );
  _tracePolyline.setLatLngs(_traceVertices);
  if (_traceControl) _traceControl.getContainer().querySelector(".trace-count").textContent = `${_traceVertices.length} pts`;
}
// ---- end tracing ----

export function setupMap(onCellClick) {
  const boundaryLatLng = SEARCH_AREA.boundary.map(([lng, lat]) => [lat, lng]);
  const areaBounds = L.latLngBounds(boundaryLatLng);

  store.map = L.map("map", { zoomControl: true, preferCanvas: true });

  const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    },
  );

  store.activeBaseLayer = streetLayer;
  streetLayer.addTo(store.map);

  // Satellite toggle control
  const SatToggle = L.Control.extend({
    onAdd() {
      const btn = L.DomUtil.create("button", "leaflet-sat-toggle");
      btn.title = "Toggle satellite view";
      btn.textContent = "Satellite";
      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (store.activeBaseLayer === streetLayer) {
          store.map.removeLayer(streetLayer);
          satelliteLayer.addTo(store.map);
          store.activeBaseLayer = satelliteLayer;
          btn.textContent = "Street";
          btn.classList.add("active");
        } else {
          store.map.removeLayer(satelliteLayer);
          streetLayer.addTo(store.map);
          store.activeBaseLayer = streetLayer;
          btn.textContent = "Satellite";
          btn.classList.remove("active");
        }
      });
      return btn;
    },
  });
  new SatToggle({ position: "topright" }).addTo(store.map);

  store.boundaryLayer = L.polygon(boundaryLatLng, {
    color: "#111827",
    weight: 3,
    opacity: 0.95,
    fill: false,
  }).addTo(store.map);

  const initialExtBoundary = state.customExtendedBoundary || SEARCH_AREA_EXTENDED.boundary;
  store.extBoundaryLayer = L.polygon(initialExtBoundary.map(([lng, lat]) => [lat, lng]), {
    color: "#111827",
    weight: 3,
    opacity: 0.95,
    fill: false,
  }).addTo(store.map);

  store.gridLayer = L.geoJSON(
    { type: "FeatureCollection", features: store.cellFeatures },
    {
      style: getCellStyle,
      onEachFeature(feature, layer) {
        layer.on("click", (event) => {
          if (store.placingLastSeen) { placeLastSeen(event.latlng); return; }
          if (store.traceBoundaryMode) { _addTraceVertex(event.latlng); return; }
          onCellClick(feature.properties.id);
        });
        layer.on("mouseover", () => layer.setStyle({ weight: 3 }));
        layer.on("mouseout", () => store.gridLayer.resetStyle(layer));
      },
    },
  ).addTo(store.map);

  store.labelLayer = L.layerGroup().addTo(store.map);
  store.volunteerLayer = L.layerGroup().addTo(store.map);
  store.lastSeenLayer = L.layerGroup().addTo(store.map);
  store.koesterLayer = L.layerGroup().addTo(store.map);
  store.cluesLayer = L.layerGroup().addTo(store.map);
  store.poiLayer = L.layerGroup().addTo(store.map);
  renderLabels();
  renderLastSeen();
  renderKoesterRings();
  renderClueMarkers();

  document.addEventListener("esti:render-clues", renderClueMarkers);
  store.map.on("zoomend", renderLabels);
  store.map.fitBounds(areaBounds.pad(0.08));

  store.map.on("click", (e) => {
    if (store.traceBoundaryMode) _addTraceVertex(e.latlng);
  });

  _bindPoiFilterBar();

  // renderer.js dispatches this instead of importing map.js directly.
  document.addEventListener("esti:render-last-seen", () => {
    renderLastSeen();
    renderKoesterRings();
  });
}

export function renderLastSeen() {
  if (!store.lastSeenLayer || !store.map) return;
  store.lastSeenLayer.clearLayers();

  // Draw trail markers (previous sightings) first so active pin renders on top.
  const trail = Array.isArray(state.lastSeenTrail) ? state.lastSeenTrail : [];
  trail.forEach((spot, i) => {
    if (!spot || !Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) return;
    const timeText = spot.time ? formatLastSeenTime(spot.time) : "–";
    const seq = i + 1;
    const marker = L.marker([spot.lat, spot.lng], {
      icon: L.divIcon({
        className: "lastseen-marker trail",
        html: `<span class="lastseen-pin trail-pin"></span><span class="lastseen-label trail-label">#${seq} ${escapeHtml(timeText)}</span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
      zIndexOffset: 1100,
    });
    marker.bindPopup(_lastSeenPopup(spot, `Sighting #${seq}`), { className: "lastseen-popup-wrap", maxWidth: 260 });
    store.lastSeenLayer.addLayer(marker);
  });

  // Draw active (most recent) pin.
  const spot = state.lastSeen;
  if (!spot || !Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) return;
  const timeText = spot.time ? formatLastSeenTime(spot.time) : "time not set";
  const marker = L.marker([spot.lat, spot.lng], {
    icon: L.divIcon({
      className: "lastseen-marker",
      html: `<span class="lastseen-pin"></span><span class="lastseen-label">Last seen<br />${escapeHtml(timeText)}</span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
    zIndexOffset: 1200,
  });
  marker.bindPopup(_lastSeenPopup(spot, "Last seen"), { className: "lastseen-popup-wrap", maxWidth: 260 });
  store.lastSeenLayer.addLayer(marker);
}

export function renderKoesterRings() {
  if (!store.koesterLayer || !store.map) return;
  store.koesterLayer.clearLayers();
  const spot = state.lastSeen;
  const category = state.missingPerson?.category;
  if (!spot || !Number.isFinite(spot.lat) || !Number.isFinite(spot.lng) || !category) return;
  const distances = KOESTER_DISTANCES[category];
  if (!distances) return;

  const rings = [
    { km: distances.p95, label: "P95", color: "#dc2626", dash: "4 4",  weight: 1.5, opacity: 0.55 },
    { km: distances.p75, label: "P75", color: "#f97316", dash: "6 3",  weight: 1.5, opacity: 0.65 },
    { km: distances.p50, label: "P50", color: "#eab308", dash: "8 4",  weight: 2,   opacity: 0.80 },
    { km: distances.p25, label: "P25", color: "#22c55e", dash: "10 4", weight: 2,   opacity: 0.90 },
  ];

  rings.forEach(({ km, label, color, dash, weight, opacity }) => {
    const circle = L.circle([spot.lat, spot.lng], {
      radius: km * 1000,
      color,
      weight,
      dashArray: dash,
      opacity,
      fill: false,
      interactive: false,
    });
    circle.bindTooltip(`${label}: ${km} km`, { permanent: false, direction: "top" });
    store.koesterLayer.addLayer(circle);
  });
}

export function renderLastSeenControl() {
  const spot = state.lastSeen;
  const trail = Array.isArray(state.lastSeenTrail) ? state.lastSeenTrail : [];
  return `
    <h3>Last-seen location</h3>
    ${
      spot
        ? `<p class="notice success">Pin is on the map${spot.time ? ` — last seen ${escapeHtml(formatLastSeenTime(spot.time))}` : ""}. Everyone searching can see it.</p>`
        : '<p class="muted tight">No pin yet. Mark where the subject was last seen so the whole team can focus there.</p>'
    }
    ${spot && spot.address ? `<p class="small">${escapeHtml(spot.address)}</p>` : ""}
    <form id="lastSeenAddressForm" class="verification-row">
      <label>Find by address
        <input id="lastSeenAddress" autocomplete="off" placeholder="123 Finch Ave W" />
      </label>
      <button id="findAddressBtn" class="button active" type="submit">Find</button>
    </form>
    <div class="button-row">
      <button id="placeLastSeenBtn" class="button primary" type="button">${
        store.placingLastSeen ? "Tap the map…" : spot ? "New sighting" : "Place pin on map"
      }</button>
      ${spot ? '<button id="removeLastSeenBtn" class="button warning" type="button">Remove pin</button>' : ""}
      ${trail.length > 0 ? '<button id="clearTrailBtn" class="button" type="button">Clear trail</button>' : ""}
    </div>
    ${trail.length > 0 ? `<p class="muted small">${trail.length} previous sighting${trail.length > 1 ? "s" : ""} shown on map.</p>` : ""}
    ${
      spot
        ? `<form id="lastSeenForm" class="login-form">
      <label>Time last seen
        <input id="lastSeenTime" type="datetime-local" value="${escapeAttr(spot.time || "")}" />
      </label>
      <label>Note
        <textarea id="lastSeenNote">${escapeHtml(spot.note || "")}</textarea>
      </label>
      <div class="photo-upload-row">
        ${spot.photoData ? `<img src="${spot.photoData}" class="photo-thumb" alt="Last-seen location photo" />` : ""}
        <label class="button full" style="cursor:pointer;text-align:center;">
          ${spot.photoData ? "Replace photo" : "Add location photo"}
          <input id="lastSeenPhotoInput" type="file" accept="image/*" hidden />
        </label>
      </div>
      <button class="button success full" type="submit">Save details</button>
    </form>`
        : ""
    }
  `;
}

export function togglePlaceLastSeen() {
  if (!state.profile.dispatcher) return;
  store.placingLastSeen = !store.placingLastSeen;
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast(store.placingLastSeen ? "Tap the map where the subject was last seen." : "Pin placement cancelled.");
}

export function placeLastSeen(latlng, address) {
  if (!state.profile.dispatcher || !latlng) return;
  const now = new Date();

  // Archive the current active pin to trail before replacing it.
  if (state.lastSeen && Number.isFinite(state.lastSeen.lat)) {
    if (!Array.isArray(state.lastSeenTrail)) state.lastSeenTrail = [];
    state.lastSeenTrail.push({ ...state.lastSeen });
    if (state.lastSeenTrail.length > 10) state.lastSeenTrail.shift();
  }

  state.lastSeen = {
    lat: latlng.lat,
    lng: latlng.lng,
    time: toLocalDatetimeValue(now),
    note: "",
    address: address || "",
    setBy: state.profile.name || "Dispatcher",
    updatedAt: now.toISOString(),
    photoData: "",
  };
  store.placingLastSeen = false;
  addAudit("last_seen_set", null, { lat: latlng.lat, lng: latlng.lng, trail: state.lastSeenTrail.length });
  saveState();
  renderLastSeen();
  renderKoesterRings();
  document.dispatchEvent(new CustomEvent("esti:render"));
  const trailCount = state.lastSeenTrail.length;
  showToast(trailCount > 0 ? `New sighting added. Previous pin kept as #${trailCount}.` : "Last-seen pin placed. Set the time, then save.");
}

export async function geocodeLastSeen(event) {
  event?.preventDefault();
  if (!state.profile.dispatcher) return;
  const input = document.getElementById("lastSeenAddress");
  const query = input?.value.trim();
  if (!query) { showToast("Type an address to look up."); return; }
  showToast("Looking up the address…");
  try {
    const lons = SEARCH_AREA.boundary.map((p) => p[0]);
    const lats = SEARCH_AREA.boundary.map((p) => p[1]);
    const viewbox = `${Math.min(...lons)},${Math.min(...lats)},${Math.max(...lons)},${Math.max(...lats)}`;
    const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1", countrycodes: "ca", viewbox, bounded: "0" });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const results = await response.json();
    if (!Array.isArray(results) || !results.length) {
      showToast("No match for that address — try adding the city, or drop a pin.");
      return;
    }
    const lat = Number(results[0].lat);
    const lng = Number(results[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      showToast("That address didn't return a usable location.");
      return;
    }
    placeLastSeen({ lat, lng }, results[0].display_name || query);
    store.map.setView([lat, lng], Math.max(store.map.getZoom(), 15));
  } catch {
    showToast("Address lookup failed. Check the connection or drop a pin instead.");
  }
}

export function saveLastSeenDetails(event) {
  event?.preventDefault();
  if (!state.lastSeen) return;
  state.lastSeen.time = document.getElementById("lastSeenTime")?.value || state.lastSeen.time;
  state.lastSeen.note = document.getElementById("lastSeenNote")?.value.trim() || "";
  state.lastSeen.setBy = state.profile.name || state.lastSeen.setBy || "Dispatcher";
  state.lastSeen.updatedAt = new Date().toISOString();
  addAudit("last_seen_updated", null, { time: state.lastSeen.time });
  saveState();
  renderLastSeen();
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast("Last-seen details saved.");
}

export function removeLastSeen() {
  state.lastSeen = null;
  store.placingLastSeen = false;
  addAudit("last_seen_cleared", null, {});
  saveState();
  renderLastSeen();
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast("Last-seen pin removed.");
}

export function clearLastSeenTrail() {
  state.lastSeenTrail = [];
  addAudit("last_seen_trail_cleared", null, {});
  saveState();
  renderLastSeen();
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast("Sighting trail cleared.");
}

export async function handleLastSeenPhoto(event) {
  const [file] = event.target.files;
  if (!file || !state.lastSeen) return;
  try {
    const dataUrl = await _compressPhoto(file, 360, 0.72);
    state.lastSeen.photoData = dataUrl;
    state.lastSeen.updatedAt = new Date().toISOString();
    addAudit("last_seen_photo_set", null, {});
    saveState();
    document.dispatchEvent(new CustomEvent("esti:render"));
    showToast("Location photo saved.");
  } catch {
    showToast("Could not load that image.");
  }
}

// ---- Clue markers ----

export function renderClueMarkers() {
  if (!store.cluesLayer) return;
  store.cluesLayer.clearLayers();
  const clues = Array.isArray(state.clues) ? state.clues : [];
  clues.forEach((clue) => {
    if (!Number.isFinite(clue.lat) || !Number.isFinite(clue.lng)) return;
    const color = clue.resolved ? "#94a3b8" : "#f59e0b";
    const marker = L.circleMarker([clue.lat, clue.lng], {
      radius: clue.resolved ? 5 : 8,
      color: clue.resolved ? "#64748b" : "#92400e",
      weight: 2,
      fillColor: color,
      fillOpacity: clue.resolved ? 0.5 : 0.9,
      zIndexOffset: 900,
    });
    const photo = clue.photoData ? `<img src="${clue.photoData}" class="popup-photo" alt="Clue photo" />` : "";
    marker.bindPopup(`
      <div class="lastseen-popup">
        <strong class="popup-title">${escapeHtml(clue.type)}</strong>
        <p class="popup-row"><span class="popup-key">Grid</span>${escapeHtml(clue.gridId || "–")}</p>
        ${clue.description ? `<p class="popup-row">${escapeHtml(clue.description)}</p>` : ""}
        <p class="popup-row"><span class="popup-key">By</span>${escapeHtml(clue.loggedBy?.name || "Volunteer")}</p>
        ${clue.resolved ? `<p class="popup-row" style="color:#16a34a"><strong>Resolved</strong> by ${escapeHtml(clue.resolvedBy || "")}</p>` : ""}
        ${photo}
      </div>
    `, { className: "lastseen-popup-wrap", maxWidth: 260 });
    store.cluesLayer.addLayer(marker);
  });
}

// ---- Hasty search mode ----

export function toggleHastyMode() {
  store.hastyMode = !store.hastyMode;
  renderHastyOverlay();
  document.dispatchEvent(new CustomEvent("esti:mode-buttons-changed"));
  showToast(store.hastyMode
    ? "Hasty mode: cells ranked by distance from IPP. Search #1 first."
    : "Hasty mode off.");
}

export function renderHastyOverlay() {
  store.hastyPriority.clear();

  if (store.hastyMode) {
    const ipp = state.lastSeen;
    const bl = SEARCH_AREA.boundary;
    const centerLng = ipp?.lng ?? (bl.reduce((s, p) => s + p[0], 0) / bl.length);
    const centerLat = ipp?.lat ?? (bl.reduce((s, p) => s + p[1], 0) / bl.length);

    store.cellFeatures
      .filter((f) => {
        const s = state.cells[f.properties.id]?.status;
        return !s || s === "open" || s === "stale";
      })
      .map((f) => {
        const [lng, lat] = f.properties.center;
        const dx = lng - centerLng, dy = lat - centerLat;
        return { id: f.properties.id, dist: dx * dx + dy * dy };
      })
      .sort((a, b) => a.dist - b.dist)
      .forEach(({ id }, i) => store.hastyPriority.set(id, i + 1));
  }

  // Refresh the grid — getCellStyle and renderLabels both read hastyPriority.
  if (store.gridLayer) store.gridLayer.setStyle(getCellStyle);
  renderLabels();
}

// ---- POI overlay ----

const POI_CATEGORIES = [
  { type: "hospital",         icon: "🏥", label: "Hospital",  color: "#dc2626" },
  { type: "pharmacy",         icon: "💊", label: "Pharmacy",  color: "#16a34a" },
  { type: "police",           icon: "🚔", label: "Police",    color: "#1d4ed8" },
  { type: "community_centre", icon: "🏛", label: "Community", color: "#7c3aed" },
  { type: "shelter",          icon: "🏠", label: "Shelter",   color: "#b45309" },
  { type: "subway_entrance",  icon: "🚇", label: "Subway",    color: "#0891b2" },
  { type: "bus_stop",         icon: "🚌", label: "Bus stop",  color: "#0891b2" },
  { type: "park",             icon: "🌳", label: "Park",      color: "#15803d" },
];

export async function togglePoiOverlay() {
  store.poiMode = !store.poiMode;
  document.dispatchEvent(new CustomEvent("esti:mode-buttons-changed"));
  if (!store.poiMode) {
    store.poiLayer?.clearLayers();
    store.poiElements = [];
    _renderPoiFilterBar();
    showToast("POI overlay off.");
    return;
  }
  _renderPoiFilterBar();
  showToast("Loading points of interest…");
  await _fetchAndRenderPois();
}

async function _fetchAndRenderPois() {
  if (!store.poiLayer) return;

  const lons = SEARCH_AREA.boundary.map((p) => p[0]);
  const lats = SEARCH_AREA.boundary.map((p) => p[1]);
  const s = Math.min(...lats), n = Math.max(...lats);
  const w = Math.min(...lons), e = Math.max(...lons);
  const bbox = `${s},${w},${n},${e}`;

  const query = `[out:json][timeout:20];(
    node["amenity"~"hospital|pharmacy|police|community_centre|shelter"](${bbox});
    node["railway"="subway_entrance"](${bbox});
    node["highway"="bus_stop"](${bbox});
    node["leisure"="park"](${bbox});
    way["leisure"="park"](${bbox});
  );out center 200;`;

  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    store.poiElements = data.elements || [];
    _renderPoiElements(store.poiElements);
    _renderPoiFilterBar();
    showToast(`${store.poiElements.length} POIs loaded.`);
  } catch {
    showToast("Could not load POIs — check connection.");
    store.poiMode = false;
    store.poiElements = [];
    document.dispatchEvent(new CustomEvent("esti:mode-buttons-changed"));
  }
}

function _renderPoiElements(elements) {
  store.poiLayer.clearLayers();
  elements.forEach((el) => {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!lat || !lng) return;
    const type = el.tags?.amenity || el.tags?.railway || el.tags?.highway || el.tags?.leisure || "default";
    if (!store.poiFilter.has(type)) return;
    const cat = POI_CATEGORIES.find((c) => c.type === type);
    const { icon, color } = cat || { icon: "📍", color: "#6b7280" };
    const name = el.tags?.name || type;
    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "poi-marker",
        html: `<span class="poi-icon" style="background:${color}">${icon}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      zIndexOffset: 850,
    });
    marker.bindTooltip(escapeHtml(name), { direction: "top" });
    store.poiLayer.addLayer(marker);
  });
}

function _renderPoiFilterBar() {
  const bar = document.getElementById("poiFilterBar");
  if (!bar) return;
  bar.hidden = !store.poiMode;
  if (!store.poiMode) return;
  bar.innerHTML = POI_CATEGORIES.map((cat) => {
    const active = store.poiFilter.has(cat.type);
    return `<button class="poi-filter-btn${active ? " active" : ""}" data-poi-type="${escapeAttr(cat.type)}" style="--poi-color:${cat.color}">${cat.icon} ${cat.label}</button>`;
  }).join("");
}

function _bindPoiFilterBar() {
  document.getElementById("poiFilterBar")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-poi-type]");
    if (!btn || !store.poiMode) return;
    const type = btn.dataset.poiType;
    if (store.poiFilter.has(type)) {
      store.poiFilter.delete(type);
    } else {
      store.poiFilter.add(type);
    }
    btn.classList.toggle("active", store.poiFilter.has(type));
    _renderPoiElements(store.poiElements);
  });
}

function _lastSeenPopup(spot, title) {
  const time = spot.time ? escapeHtml(formatLastSeenTime(spot.time)) : "<em>Time not set</em>";
  const address = spot.address ? `<p class="popup-row"><span class="popup-key">Address</span>${escapeHtml(spot.address)}</p>` : "";
  const note = spot.note ? `<p class="popup-row"><span class="popup-key">Note</span>${escapeHtml(spot.note)}</p>` : "";
  const setBy = spot.setBy ? `<p class="popup-row"><span class="popup-key">Set by</span>${escapeHtml(spot.setBy)}</p>` : "";
  const photo = spot.photoData
    ? `<img src="${spot.photoData}" class="popup-photo" alt="Location photo" />`
    : "";
  return `
    <div class="lastseen-popup">
      <strong class="popup-title">${escapeHtml(title)}</strong>
      <p class="popup-time">${time}</p>
      ${address}${note}${setBy}${photo}
    </div>
  `;
}

function _compressPhoto(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
