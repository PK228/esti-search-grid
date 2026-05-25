import { POSITIONS_API, POSITION_SYNC_MS, POSITIONS_KEY_STORE, POSITION_IDLE_MS, POSITION_FRESH_MS, POSITION_STALE_MS, SEARCH_ID } from "./constants.js";
import { state } from "./state.js";
import { store } from "./store.js";
import { showToast } from "../utils/toast.js";
import { escapeAttr, escapeHtml } from "../utils/format.js";

export function startPositionSync() {
  fetchVolunteerPositions();
  store.positionSyncTimer = window.setInterval(() => {
    pushMyPosition();
    fetchVolunteerPositions();
  }, POSITION_SYNC_MS);
}

export async function pushMyPosition() {
  if (store.gpsWatchId === null || !store.lastGpsFix) return;
  try {
    await fetch(POSITIONS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: state.profile.userId,
        name: state.profile.name || "Volunteer",
        team: state.profile.team || "",
        lat: store.lastGpsFix.lat,
        lng: store.lastGpsFix.lng,
        accuracy: store.lastGpsFix.accuracy,
        ...(SEARCH_ID ? { searchId: SEARCH_ID } : {}),
      }),
    });
  } catch {
    // Best-effort; ignore transient network failures.
  }
}

export async function fetchVolunteerPositions() {
  if (!store.positionsKey) {
    _setPositionFeedStatus(
      "locked",
      "Location feed locked. Enter the dispatcher location key to show GPS pings.",
      0,
    );
    renderVolunteerMarkers([]);
    return;
  }
  try {
    const searchParam = SEARCH_ID ? `&s=${encodeURIComponent(SEARCH_ID)}` : "";
    const response = await fetch(`${POSITIONS_API}?t=${Date.now()}${searchParam}`, {
      cache: "no-store",
      headers: { "x-positions-key": store.positionsKey },
    });
    if (!response.ok) {
      if (response.status === 403) {
        _setPositionFeedStatus("rejected", "Location key rejected. Re-enter the dispatcher location key.", 0);
        renderVolunteerMarkers([]);
      } else {
        _setPositionFeedStatus("error", `Location feed returned HTTP ${response.status}.`, store.positionCount);
      }
      return;
    }
    const payload = await response.json();
    const positions = Array.isArray(payload.positions) ? payload.positions : [];
    _setPositionFeedStatus(
      positions.length ? "live" : "empty",
      positions.length
        ? `${positions.length} recent volunteer GPS ping${positions.length === 1 ? "" : "s"} loaded.`
        : "Location feed connected, but no recent volunteer GPS pings are available for this search.",
      positions.length,
    );
    renderVolunteerMarkers(positions);
  } catch {
    _setPositionFeedStatus("error", "Could not reach the location feed.", store.positionCount);
    // Keep last drawn markers on refresh failure.
  }
}

export async function savePositionsKey() {
  const input = document.getElementById("positionsKeyInput");
  const value = input ? input.value.trim() : "";
  store.positionsKey = value;
  if (!value) {
    localStorage.removeItem(POSITIONS_KEY_STORE);
    _setPositionFeedStatus(
      "locked",
      "Location feed locked. Enter the dispatcher location key to show GPS pings.",
      0,
    );
    renderVolunteerMarkers([]);
    document.dispatchEvent(new CustomEvent("esti:render"));
    showToast("Location key cleared.");
    return;
  }
  localStorage.setItem(POSITIONS_KEY_STORE, value);
  try {
    const searchParam = SEARCH_ID ? `&s=${encodeURIComponent(SEARCH_ID)}` : "";
    const response = await fetch(`${POSITIONS_API}?t=${Date.now()}${searchParam}`, {
      cache: "no-store",
      headers: { "x-positions-key": value },
    });
    if (response.ok) {
      const payload = await response.json();
      const positions = Array.isArray(payload.positions) ? payload.positions : [];
      _setPositionFeedStatus(
        positions.length ? "live" : "empty",
        positions.length
          ? `${positions.length} recent volunteer GPS ping${positions.length === 1 ? "" : "s"} loaded.`
          : "Location feed connected, but no recent volunteer GPS pings are available for this search.",
        positions.length,
      );
      renderVolunteerMarkers(positions);
      showToast("Location feed unlocked.");
    } else {
      _setPositionFeedStatus("rejected", "Location key rejected. Re-enter the dispatcher location key.", 0);
      renderVolunteerMarkers([]);
      showToast("Location key was rejected.");
    }
  } catch {
    _setPositionFeedStatus("error", "Could not reach the location feed.", store.positionCount);
    showToast("Could not reach the location feed.");
  }
  document.dispatchEvent(new CustomEvent("esti:render"));
}

function _setPositionFeedStatus(status, message, count) {
  store.positionFeedStatus = status;
  store.positionFeedMessage = message;
  store.positionCount = count;
  const el = document.getElementById("positionFeedStatus");
  if (el) {
    el.className = `notice position-feed-status position-feed-status--${status}`;
    el.textContent = message;
  }
}

function _abbrevName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/);
  if (parts.length < 2) return fullName || "Volunteer";
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function renderVolunteerMarkers(positions) {
  if (!store.volunteerLayer) return;
  store.volunteerLayer.clearLayers();
  const now = Date.now();
  const nowOccupied = new Set();
  const newPositions = new Map();

  positions.forEach((position) => {
    if (!position) return;
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return;
    if (typeof position.updatedAt === "number" && now - position.updatedAt > POSITION_IDLE_MS) return;
    const isSelf = position.userId === state.profile.userId;
    const fullName = position.name || "Volunteer";
    const abbrev = escapeHtml(isSelf ? `${_abbrevName(fullName)} (you)` : _abbrevName(fullName));
    const age = now - (position.updatedAt || 0);
    const freshnessClass = age < POSITION_FRESH_MS ? "vol-fresh" : age < POSITION_STALE_MS ? "vol-stale" : "vol-offgrid";
    const ageMins = Math.round(age / 60000);
    const ageText = ageMins < 1 ? "just now" : `${ageMins} min ago`;
    const info = store.volunteerInfoMap?.get(position.userId);
    const phone = info?.phone || "";
    const email = info?.email || "";
    const popupHtml = `<div class="vol-popup">
      <strong>${escapeHtml(fullName)}</strong>${isSelf ? " <em>(you)</em>" : ""}
      ${position.team ? `<div class="vol-popup-grid">Grid <strong>${escapeHtml(position.team)}</strong></div>` : ""}
      ${phone ? `<a href="tel:${escapeAttr(phone.replace(/[^\d+]/g, ""))}" class="vol-popup-contact">📞 ${escapeHtml(phone)}</a>` : ""}
      ${email ? `<a href="mailto:${escapeAttr(email)}" class="vol-popup-contact">✉ ${escapeHtml(email)}</a>` : ""}
      <div class="vol-popup-age">Ping: ${ageText}</div>
    </div>`;
    const marker = L.marker([position.lat, position.lng], {
      interactive: true,
      icon: L.divIcon({
        className: "volunteer-marker",
        html: `<span class="volunteer-dot ${freshnessClass}"></span><span class="volunteer-name">${abbrev}</span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
      zIndexOffset: 800,
    }).bindPopup(popupHtml, { className: "vol-popup-wrap", maxWidth: 200, closeButton: false });
    store.volunteerLayer.addLayer(marker);
    newPositions.set(position.userId, { lat: position.lat, lng: position.lng });

    // Detect if volunteer is inside their assigned cell.
    const cellId = position.team;
    if (cellId && window.turf) {
      const feature = store.cellLookup.get(cellId);
      if (feature) {
        try {
          if (window.turf.booleanPointInPolygon(window.turf.point([position.lng, position.lat]), feature)) {
            nowOccupied.add(cellId);
          }
        } catch { /* ignore */ }
      }
    }
  });

  store.volunteerPositions = newPositions;

  // Fire a grid refresh only when occupation state actually changes.
  const prev = store.occupiedCells;
  const changed = nowOccupied.size !== prev.size || [...nowOccupied].some((id) => !prev.has(id));
  store.occupiedCells = nowOccupied;
  if (changed) document.dispatchEvent(new CustomEvent("esti:grid-update"));
}
