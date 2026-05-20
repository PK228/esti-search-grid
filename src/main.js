import { state, ensureIdentity, saveState } from "./core/state.js";
import { store } from "./core/store.js";
import { startSharedSync } from "./core/sync.js";
import { startPositionSync } from "./core/positions.js";
import { HEARTBEAT_SCAN_MS } from "./core/constants.js";
import { addAudit } from "./core/audit.js";
import { buildGrid, buildExtendedGrid } from "./grid/builder.js";
import { scanStaleCells } from "./grid/cells.js";
import { refreshGrid } from "./grid/renderer.js";
import { setupMap, toggleHastyMode, togglePoiOverlay, renderHastyOverlay } from "./ui/map.js";
import { toggleGps, updateGpsStatus } from "./ui/gps.js";
import { startTraceBoundary, cancelTraceBoundary } from "./ui/map.js";
import { renderPanel } from "./ui/panel.js";
import { exportState, importStateFromFile } from "./utils/export.js";
import { showToast } from "./utils/toast.js";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

document.addEventListener("DOMContentLoaded", init);

function init() {
  if (!window.L || !window.turf) {
    document.body.innerHTML =
      '<main class="panel"><h1>Map failed to load</h1><p class="muted">Check the internet connection and refresh this page.</p></main>';
    return;
  }

  ensureIdentity();
  _tryDispatcherAutoLogin();
  buildGrid();
  buildExtendedGrid();
  scanStaleCells({ silent: true });
  setupMap(selectCell);
  _bindGlobalActions();
  renderPanel();
  updateGpsStatus("GPS idle");
  _refreshModeButtons();
  startSharedSync();
  startPositionSync();
  store.staleTimer = window.setInterval(() => scanStaleCells(), HEARTBEAT_SCAN_MS);

  // ---- Event bus ----
  // Modules dispatch custom events instead of calling renderPanel() directly,
  // which keeps circular imports out of the module graph.

  document.addEventListener("esti:render", () => {
    refreshGrid();
    if (store.hastyMode) renderHastyOverlay();
    if (!store.dispatcherLoginOpen && !_panelInputFocused()) renderPanel();
  });

  document.addEventListener("esti:mode-buttons-changed", _refreshModeButtons);

  document.addEventListener("esti:shared-state-applied", () => {
    refreshGrid();
    if (!store.dispatcherLoginOpen && !_panelInputFocused()) renderPanel();
  });

  document.addEventListener("esti:sync-status-changed", () => {
    if (!store.activeCellId && !store.dispatcherLoginOpen && !store.zonePanelOpen && !_panelInputFocused()) renderPanel();
    _updateSyncDot();
  });

  function _updateSyncDot() {
    const dot = document.getElementById("syncDot");
    if (!dot) return;
    dot.className = `sync-dot sync-dot--${store.sharedSyncStatus || "connecting"}`;
    dot.title = `Sync: ${store.sharedSyncStatus || "connecting"}`;
  }

  document.addEventListener("esti:dispatcher-mode-changed", () => {
    _refreshModeButtons();
    renderPanel();
    if (state.profile.dispatcher) {
      requestAnimationFrame(() => {
        const dashboard = document.getElementById("dispatcherDashboard");
        dashboard?.scrollIntoView({ block: "start", behavior: "smooth" });
        dashboard?.focus({ preventScroll: true });
      });
    }
  });

  document.addEventListener("esti:select-cell", (e) => selectCell(e.detail));
  document.addEventListener("esti:deselect-cell", () => {
    store.activeCellId = null;
    refreshGrid();
    renderPanel();
  });
  document.addEventListener("esti:import-complete", () => {
    store.activeCellId = null;
    refreshGrid();
    renderPanel();
  });
}

function selectCell(id) {
  store.activeCellId = id;
  refreshGrid();
  renderPanel();
}

function _bindGlobalActions() {
  document.getElementById("locateBtn").addEventListener("click", toggleGps);
  document.getElementById("zonesBtn").addEventListener("click", _toggleZonePanel);
  document.getElementById("areaBtn").addEventListener("click", () => {
    store.map.fitBounds(store.boundaryLayer.getBounds().pad(0.08));
  });
  document.getElementById("heatBtn").addEventListener("click", _toggleHeatMode);
  document.getElementById("hastyBtn").addEventListener("click", toggleHastyMode);
  document.getElementById("poiBtn").addEventListener("click", togglePoiOverlay);
  document.getElementById("dispatcherBtn").addEventListener("click", _toggleDispatcherMode);
  document.getElementById("traceBtn").addEventListener("click", () => {
    if (store.traceBoundaryMode) cancelTraceBoundary();
    else startTraceBoundary();
  });
  document.getElementById("exportBtn").addEventListener("click", exportState);
  document.getElementById("importBtn").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", importStateFromFile);
}

function _refreshModeButtons() {
  const isDispatcher = state.profile.dispatcher || store.dispatcherLoginOpen;

  // Volunteer-only view: just Locate Me + POIs.
  // Dispatcher mode unlocks the full toolbar.
  const dispatcherOnlyIds = ["areaBtn", "heatBtn", "hastyBtn", "zonesBtn", "dispatcherBtn", "traceBtn", "exportBtn", "importBtn"];
  dispatcherOnlyIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !isDispatcher;
  });

  const heatBtn = document.getElementById("heatBtn");
  const hastyBtn = document.getElementById("hastyBtn");
  const poiBtn = document.getElementById("poiBtn");
  const dispatcherBtn = document.getElementById("dispatcherBtn");
  const zonesBtn = document.getElementById("zonesBtn");
  if (heatBtn) {
    heatBtn.textContent = store.heatMode ? "Status" : "Heat";
    heatBtn.classList.toggle("active", store.heatMode);
  }
  if (hastyBtn) {
    hastyBtn.textContent = store.hastyMode ? "Hasty on" : "Hasty";
    hastyBtn.classList.toggle("active", store.hastyMode);
  }
  if (poiBtn) {
    poiBtn.textContent = store.poiMode ? "POIs on" : "POIs";
    poiBtn.classList.toggle("active", store.poiMode);
  }
  if (dispatcherBtn) {
    dispatcherBtn.textContent = state.profile.dispatcher
      ? "Exit dispatch"
      : store.dispatcherLoginOpen
        ? "Cancel"
        : "Dispatcher";
    dispatcherBtn.classList.toggle("active", state.profile.dispatcher || store.dispatcherLoginOpen);
  }
  if (zonesBtn) {
    zonesBtn.classList.toggle("active", store.zonePanelOpen);
  }
  const traceBtn = document.getElementById("traceBtn");
  if (traceBtn) {
    traceBtn.textContent = store.traceBoundaryMode ? "Stop tracing" : "Trace boundary";
    traceBtn.classList.toggle("active", store.traceBoundaryMode);
  }
}

function _toggleZonePanel() {
  store.zonePanelOpen = !store.zonePanelOpen;
  if (store.zonePanelOpen) {
    store.activeCellId = null;
    store.activeZoneId = null;
    store.dispatcherLoginOpen = false;
  }
  _refreshModeButtons();
  renderPanel();
}

function _toggleHeatMode() {
  store.heatMode = !store.heatMode;
  refreshGrid();
  _refreshModeButtons();
  showToast(store.heatMode ? "Heat map shows audit activity." : "Status colors restored.");
}

function _panelInputFocused() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
  return document.getElementById("panel")?.contains(active) ?? false;
}

function _tryDispatcherAutoLogin() {
  const flag = localStorage.getItem("esti-dispatcher-autologin");
  const pin  = localStorage.getItem("esti-dispatcher-pin-entry");
  if (flag !== "1" || !pin) return;
  localStorage.removeItem("esti-dispatcher-autologin");
  localStorage.removeItem("esti-dispatcher-pin-entry");
  // Lazy import to avoid circular dep at module load time.
  import("./ui/dispatcher.js").then(({ enterDispatcherMode: _enter }) => {
    // Simulate the pin being typed into the hidden input.
    const dummy = document.createElement("input");
    dummy.id = "dispatcherPin";
    dummy.value = pin;
    document.body.appendChild(dummy);
    try { _enter(); } finally { dummy.remove(); }
  }).catch(() => {});
}

function _toggleDispatcherMode() {
  if (state.profile.dispatcher) {
    state.profile.dispatcher = false;
    state.profile.role = "volunteer";
    store.dispatcherLoginOpen = false;
    addAudit("dispatcher_mode_exited", null, {});
    saveState();
    _refreshModeButtons();
    renderPanel();
    showToast("Dispatcher mode off.");
    return;
  }
  store.dispatcherLoginOpen = !store.dispatcherLoginOpen;
  if (store.dispatcherLoginOpen) store.activeCellId = null;
  _refreshModeButtons();
  refreshGrid();
  renderPanel();
}
