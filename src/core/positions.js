import { POSITIONS_API, POSITION_SYNC_MS, POSITIONS_KEY_STORE, POSITION_IDLE_MS, POSITION_FRESH_MS, POSITION_STALE_MS, SEARCH_ID } from "./constants.js";
import { state } from "./state.js";
import { store } from "./store.js";
import { showToast } from "../utils/toast.js";
import { escapeAttr } from "../utils/format.js";

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
      if (response.status === 403) renderVolunteerMarkers([]);
      return;
    }
    const payload = await response.json();
    renderVolunteerMarkers(Array.isArray(payload.positions) ? payload.positions : []);
  } catch {
    // Keep last drawn markers on refresh failure.
  }
}

export async function savePositionsKey() {
  const input = document.getElementById("positionsKeyInput");
  const value = input ? input.value.trim() : "";
  store.positionsKey = value;
  if (!value) {
    localStorage.removeItem(POSITIONS_KEY_STORE);
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
      renderVolunteerMarkers(Array.isArray(payload.positions) ? payload.positions : []);
      showToast("Location feed unlocked.");
    } else {
      renderVolunteerMarkers([]);
      showToast("Location key was rejected.");
    }
  } catch {
    showToast("Could not reach the location feed.");
  }
  document.dispatchEvent(new CustomEvent("esti:render"));
}

function renderVolunteerMarkers(positions) {
  if (!store.volunteerLayer) return;
  store.volunteerLayer.clearLayers();
  const now = Date.now();
  positions.forEach((position) => {
    if (!position || position.userId === state.profile.userId) return;
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return;
    if (typeof position.updatedAt === "number" && now - position.updatedAt > POSITION_IDLE_MS) return;
    const name = escapeAttr(position.name || "Volunteer");
    const age = now - (position.updatedAt || 0);
    const freshnessClass = age < POSITION_FRESH_MS ? "vol-fresh" : age < POSITION_STALE_MS ? "vol-stale" : "vol-offgrid";
    const marker = L.marker([position.lat, position.lng], {
      interactive: false,
      icon: L.divIcon({
        className: "volunteer-marker",
        html: `<span class="volunteer-dot ${freshnessClass}"></span><span class="volunteer-name">${name}</span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
      zIndexOffset: 800,
    });
    store.volunteerLayer.addLayer(marker);
  });
}
