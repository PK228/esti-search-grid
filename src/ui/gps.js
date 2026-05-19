import { STATUS } from "../core/constants.js";
import { state } from "../core/state.js";
import { store } from "../core/store.js";
import { findContainingCell } from "../grid/builder.js";
import { refreshGrid } from "../grid/renderer.js";
import { pushMyPosition } from "../core/positions.js";
import { showToast } from "../utils/toast.js";
import { sendHeartbeat, findSearcherIndex } from "../grid/cells.js";

const AUTO_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_HEARTBEAT_MAX_ACCURACY_M = 75;
const AUTO_HEARTBEAT_MIN_SPEED_MPS = 0.5;
const AUTO_HEARTBEAT_MIN_DISTANCE_M = 10;
const AUTO_HEARTBEAT_REQUIRED_GOOD_FIXES = 2;

export function toggleGps() {
  if (store.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(store.gpsWatchId);
    store.gpsWatchId = null;
    store.gpsCellId = null;
    store.lastGpsFix = null;
    store.didCenterGps = false;
    store.autoHeartbeatCellId = null;
    store.autoHeartbeatGoodFixCount = 0;
    store.autoHeartbeatStatus = "inactive";
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
  store.gpsWatchId = navigator.geolocation.watchPosition(handleGps, handleGpsError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 14000,
  });
}

export function handleGps(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const latLng = [latitude, longitude];
  const firstFix = !store.lastGpsFix;

  const prevFix = store.lastGpsFix;
  store.lastGpsFix = { lat: latitude, lng: longitude, accuracy: accuracy || null, recordedAt: Date.now() };

  if (!store.gpsMarker) {
    store.gpsMarker = L.marker(latLng, {
      icon: L.divIcon({
        className: "",
        html: '<div class="user-location-dot"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      zIndexOffset: 1000,
    }).addTo(store.map);
  } else {
    store.gpsMarker.setLatLng(latLng);
  }

  if (!store.gpsAccuracy) {
    store.gpsAccuracy = L.circle(latLng, {
      radius: accuracy || 0,
      color: "#6d28d9",
      weight: 1,
      fillColor: "#6d28d9",
      fillOpacity: 0.08,
    }).addTo(store.map);
  } else {
    store.gpsAccuracy.setLatLng(latLng).setRadius(accuracy || 0);
  }

  if (!store.didCenterGps) {
    store.map.setView(latLng, Math.max(store.map.getZoom(), 15));
    store.didCenterGps = true;
  }

  const newGpsCellId = findContainingCell(longitude, latitude);
  store.gpsCellId = newGpsCellId;
  refreshGrid();

  if (newGpsCellId) {
    const status = state.cells[newGpsCellId]?.status || "open";
    updateGpsStatus(
      `GPS: grid ${newGpsCellId}, ${STATUS[status].label.toLowerCase()}, accuracy ${Math.round(accuracy || 0)} m`,
    );
  } else {
    updateGpsStatus(`GPS: outside search area, accuracy ${Math.round(accuracy || 0)} m`);
  }

  if (firstFix) pushMyPosition();

  _maybeAutoHeartbeat(position, prevFix, store.lastGpsFix, newGpsCellId);
}

export function handleGpsError(error) {
  document.getElementById("locateBtn").textContent = "Locate me";
  store.gpsWatchId = null;
  const message =
    error.code === error.PERMISSION_DENIED ? "GPS permission denied." : "GPS could not get a position.";
  updateGpsStatus(message);
  showToast(message);
}

export function updateGpsStatus(message) {
  const el = document.getElementById("gpsStatus");
  if (el) el.textContent = message;
}

// ---- Auto-heartbeat helpers ----

function _maybeAutoHeartbeat(position, prevFix, currentFix, cellId) {
  if (!cellId) {
    store.autoHeartbeatStatus = "inactive";
    store.autoHeartbeatCellId = null;
    store.autoHeartbeatGoodFixCount = 0;
    return;
  }

  if (!_hasGoodAccuracy(currentFix)) {
    store.autoHeartbeatStatus = "poor_accuracy";
    store.autoHeartbeatCellId = null;
    store.autoHeartbeatGoodFixCount = 0;
    return;
  }

  const cell = state.cells[cellId];
  if (!cell || cell.status !== "searching" || findSearcherIndex(cell) === -1) {
    store.autoHeartbeatStatus = "not_searching_here";
    store.autoHeartbeatCellId = null;
    store.autoHeartbeatGoodFixCount = 0;
    return;
  }

  // Track consecutive good fixes in the same cell to handle presence (standing still).
  if (store.autoHeartbeatCellId !== cellId) {
    store.autoHeartbeatCellId = cellId;
    store.autoHeartbeatGoodFixCount = 1;
  } else {
    store.autoHeartbeatGoodFixCount += 1;
  }

  const moving = _isMoving(position, prevFix, currentFix);
  const enoughFixes = store.autoHeartbeatGoodFixCount >= AUTO_HEARTBEAT_REQUIRED_GOOD_FIXES;

  if (!moving && !enoughFixes) return;

  // Respect per-cell cooldown.
  const lastAt = store.lastAutoHeartbeatAtByCell[cellId] || 0;
  if (Date.now() - lastAt < AUTO_HEARTBEAT_INTERVAL_MS) {
    store.autoHeartbeatStatus = "active";
    return;
  }

  const source = moving ? "gps_movement" : "gps_presence";
  const recorded = sendHeartbeat(cellId, { silent: true, source });
  if (recorded) {
    store.lastAutoHeartbeatAtByCell[cellId] = Date.now();
    store.autoHeartbeatStatus = "active";
  }
}

function _hasGoodAccuracy(fix) {
  return Number.isFinite(fix?.accuracy) && fix.accuracy <= AUTO_HEARTBEAT_MAX_ACCURACY_M;
}

function _isMoving(position, prevFix, currentFix) {
  const speed = position.coords.speed;
  if (Number.isFinite(speed)) return speed >= AUTO_HEARTBEAT_MIN_SPEED_MPS;
  if (!prevFix) return false;
  return _distanceMeters(prevFix, currentFix) >= AUTO_HEARTBEAT_MIN_DISTANCE_M;
}

function _distanceMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * (Math.PI / 180);
  const dLng = (b.lng - a.lng) * (Math.PI / 180);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const c =
    sinDLat * sinDLat +
    Math.cos(a.lat * (Math.PI / 180)) * Math.cos(b.lat * (Math.PI / 180)) * sinDLng * sinDLng;
  return 2 * R * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}
