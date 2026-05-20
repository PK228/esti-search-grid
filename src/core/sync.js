import { SHARED_STATE_API, SHARED_POLL_MS, SEARCH_ID } from "./constants.js";
import { state, normalizeCells, saveLocalOnly, sharedPayload } from "./state.js";
import { store } from "./store.js";
import { showToast } from "../utils/toast.js";

export function startSharedSync() {
  fetchSharedState({ initial: true });
  store.sharedSyncTimer = window.setInterval(() => fetchSharedState(), SHARED_POLL_MS);
}

export async function fetchSharedState(options = {}) {
  try {
    const searchParam = SEARCH_ID ? `&s=${encodeURIComponent(SEARCH_ID)}` : "";
    const response = await fetch(`${SHARED_STATE_API}?t=${Date.now()}${searchParam}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const remote = payload.state || {};
    if (remote.updatedAt && remote.updatedAt !== store.lastSharedUpdatedAt) {
      const applied = applySharedState(remote);
      // Only advance the cursor if the state was actually applied; if a write
      // was in flight we skipped the apply — try again on the next poll.
      if (applied) store.lastSharedUpdatedAt = remote.updatedAt;
    }
    store.sharedWritesPaused = false;
    setSharedSyncStatus("live");
  } catch {
    store.sharedWritesPaused = false;
    setSharedSyncStatus("offline");
    if (options.initial) {
      showToast("Shared sync is offline; using this device only.");
    }
  }
}

function applySharedState(remote) {
  if (store.sharedWriteInFlight || store.sharedWriteQueued) return false;

  state.cells = normalizeCells(
    remote.cells && typeof remote.cells === "object" ? remote.cells : {},
  );
  state.audit = Array.isArray(remote.audit) ? remote.audit : [];
  state.incidents = Array.isArray(remote.incidents) ? remote.incidents : [];
  state.lastSeen = remote.lastSeen || null;
  state.lastSeenTrail = Array.isArray(remote.lastSeenTrail) ? remote.lastSeenTrail : [];
  state.clues = Array.isArray(remote.clues) ? remote.clues : state.clues || [];
  if (remote.missingPerson && typeof remote.missingPerson === "object") {
    state.missingPerson = { ...state.missingPerson, ...remote.missingPerson };
  }
  if (remote.zones && typeof remote.zones === "object") {
    state.zones = remote.zones;
  }
  if (Array.isArray(remote.missingStreets)) {
    state.missingStreets = remote.missingStreets;
  }
  saveLocalOnly();
  document.dispatchEvent(new CustomEvent("esti:shared-state-applied"));
  return true;
}

export function scheduleSharedWrite() {
  if (store.sharedWritesPaused) return;
  store.sharedWriteQueued = true;
  window.clearTimeout(store.sharedWriteTimer);
  store.sharedWriteTimer = window.setTimeout(pushSharedState, 250);
}

export async function pushSharedState() {
  if (store.sharedWritesPaused || store.sharedWriteInFlight) return;
  store.sharedWriteQueued = false;
  store.sharedWriteInFlight = true;
  try {
    const response = await fetch(SHARED_STATE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sharedPayload()),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.state?.updatedAt) {
      store.lastSharedUpdatedAt = payload.state.updatedAt;
    }
    setSharedSyncStatus("live");
  } catch {
    setSharedSyncStatus("offline");
    showToast("Shared sync failed — will retry.");
    // Reschedule so the local change eventually reaches the server.
    window.setTimeout(() => scheduleSharedWrite(), 8000);
  } finally {
    store.sharedWriteInFlight = false;
  }
}

export function setSharedSyncStatus(status) {
  store.sharedSyncStatus = status;
  document.dispatchEvent(new CustomEvent("esti:sync-status-changed"));
}

// Wire saveState → scheduleSharedWrite without state.js importing sync.js.
document.addEventListener("esti:save-state", () => scheduleSharedWrite());
