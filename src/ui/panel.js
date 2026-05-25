import { STATUS, KOESTER_CATEGORIES, SHARED_STATE_API, SEARCH_ID } from "../core/constants.js";
import { state, saveState, defaultMissingPerson } from "../core/state.js";
import { session } from "../core/session.js";
import { store } from "../core/store.js";
import { addAudit } from "../core/audit.js";
import {
  getCounts, getAnalytics, getCellsByStatus, getRecentActivity,
  getStaleEta, getSearchers, isOwnedByCurrentUser,
  updateCell, sendHeartbeat, releaseCell, clearCell, scanStaleCells,
} from "../grid/cells.js";
import { getOpenIncidentForGrid, resolveIncidentForGrid } from "../grid/incidents.js";
import { renderDispatcherDashboard, renderDispatcherLogin, bindDispatcherLogin, loadVolunteerQueue, bindVolunteerQueueActions, bindDispatcherDashboard, renderQueueTab, getVolunteerCount } from "./dispatcher.js";
import { renderZonePanel, renderZoneDetail, bindZonePanel, bindZoneDetail } from "./zone-panel.js";
import { exportState, exportAudit } from "../utils/export.js";
import { togglePlaceLastSeen, removeLastSeen, clearLastSeenTrail, geocodeLastSeen, saveLastSeenDetails, handleLastSeenPhoto, renderClueMarkers } from "./map.js";
import { CLUE_TYPES, getCluesForGrid, getOpenClues, logClue, resolveClue } from "../grid/clues.js";
import { savePositionsKey } from "../core/positions.js";
import { fetchSharedState } from "../core/sync.js";
import { escapeHtml, escapeAttr, formatTime, formatRelativeAge, shortId, maskPhone, humanAction } from "../utils/format.js";
import { showToast } from "../utils/toast.js";

export { getCellsByStatus }; // re-export so dispatcher.js stays clean

function _renderPanelTabBar(activeTab) {
  const count = getVolunteerCount();
  const badge = count > 0 ? `<span class="panel-tab-badge">${count}</span>` : "";
  return `
    <div class="panel-tabs" id="panelTabBar">
      <button class="panel-tab${activeTab === "command" ? " active" : ""}" data-tab="command" type="button">Command</button>
      <button class="panel-tab${activeTab === "queue" ? " active" : ""}" data-tab="queue" type="button">Queue${badge}</button>
      <button class="panel-tab${activeTab === "zones" ? " active" : ""}" data-tab="zones" type="button">Zones</button>
    </div>`;
}

function _bindPanelTabs() {
  const tabBar = document.getElementById("panelTabBar");
  if (!tabBar) return;
  tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    const newTab = btn.dataset.tab;
    if (newTab === store.panelTab) return;
    store.panelTab = newTab;
    store.zonePanelOpen = (newTab === "zones");
    if (newTab === "zones") {
      store.activeCellId = null;
      store.activeZoneId = null;
      store.dispatcherLoginOpen = false;
    }
    document.dispatchEvent(new CustomEvent("esti:mode-buttons-changed"));
    renderPanel();
  });
}

export function renderPanel() {
  const panel = document.getElementById("panel");

  // Dispatcher login screen
  if (store.dispatcherLoginOpen && !state.profile.dispatcher) {
    panel.innerHTML = renderDispatcherLogin();
    bindDispatcherLogin();
    return;
  }

  // Cell detail takes priority over tabs
  if (store.activeCellId) {
    panel.innerHTML = renderCellPanel(store.activeCellId);
    bindCellPanel(store.activeCellId);
    return;
  }

  // Dispatcher: tab bar layout
  if (state.profile.dispatcher) {
    const tab = store.panelTab || "command";
    store.zonePanelOpen = (tab === "zones");

    let content = "";
    if (tab === "zones") {
      try {
        content = store.activeZoneId ? renderZoneDetail(store.activeZoneId) : renderZonePanel();
      } catch (err) {
        content = `<p class="notice danger"><strong>Zone panel error:</strong> ${escapeHtml(String(err))}</p><button id="zoneErrBack" class="button" type="button">Back</button>`;
        console.error("Zone panel error:", err);
      }
    } else if (tab === "queue") {
      content = renderQueueTab();
    } else {
      content = renderCommandPanel();
    }

    panel.innerHTML = _renderPanelTabBar(tab) + content;
    _bindPanelTabs();

    if (tab === "zones") {
      if (store.activeZoneId) bindZoneDetail(store.activeZoneId, _openZoneList);
      else bindZonePanel(_openZoneDetail, _closeZonePanel);
      document.getElementById("zoneErrBack")?.addEventListener("click", _closeZonePanel);
    } else if (tab === "queue") {
      loadVolunteerQueue();
      bindVolunteerQueueActions();
    } else {
      bindCommandPanel();
      bindDispatcherDashboard();
      loadVolunteerQueue(); // keep cache warm so badge shows correct count
    }
    return;
  }

  // Non-dispatcher: zone panel or default
  if (store.zonePanelOpen) {
    try {
      if (store.activeZoneId) {
        panel.innerHTML = renderZoneDetail(store.activeZoneId);
        bindZoneDetail(store.activeZoneId, _openZoneList);
      } else {
        panel.innerHTML = renderZonePanel();
        bindZonePanel(_openZoneDetail, _closeZonePanel);
      }
    } catch (err) {
      panel.innerHTML = `<p class="notice danger"><strong>Zone panel error:</strong> ${escapeHtml(String(err))}</p><button id="zoneErrBack" class="button" type="button">Back</button>`;
      document.getElementById("zoneErrBack")?.addEventListener("click", _closeZonePanel);
      console.error("Zone panel error:", err);
    }
    return;
  }

  panel.innerHTML = renderCommandPanel();
  bindCommandPanel();
}

function _openZoneDetail(id) {
  store.activeZoneId = id;
  renderPanel();
}

function _openZoneList() {
  store.activeZoneId = null;
  renderPanel();
}

function _closeZonePanel() {
  store.zonePanelOpen = false;
  store.activeZoneId = null;
  store.panelTab = "command";
  renderPanel();
  document.dispatchEvent(new CustomEvent("esti:mode-buttons-changed"));
}

function renderCommandPanel() {
  const counts = getCounts();
  const activity = getRecentActivity();
  const isDispatcher = state.profile.dispatcher;

  if (isDispatcher) {
    const analytics = getAnalytics(counts);
    return `
      <h2>Command Board</h2>
      <p class="muted tight">${store.cellFeatures.length} grid squares, ${state.search?.gridCellKm || 0.5} km each. Grid updates sync across phones.</p>
      <p class="sync-line ${store.sharedSyncStatus === "live" ? "live" : "offline"}">Shared sync: ${escapeHtml(store.sharedSyncStatus)}</p>
      <div class="summary-grid">
        ${summaryItem(counts.open, "Open")}
        ${summaryItem(counts.searching, "Searching")}
        ${summaryItem(counts.done, "Complete")}
        ${summaryItem(counts.backup + counts.emergency + counts.found, "Escalations")}
      </div>
      <div class="metric-grid">
        ${metricItem(`${analytics.coverage}%`, "Coverage")}
        ${metricItem(String(counts.stale), "Stale released")}
        ${metricItem(String(analytics.openIncidents), "Open incidents")}
        ${metricItem(String(analytics.volunteersSearching), "Volunteers out")}
      </div>
      ${renderMissingPersonSection()}
      ${renderWhatsAppShare()}
      ${renderDispatcherDashboard()}
      <div class="divider"></div>
      <h3>Recent Updates</h3>
      ${renderActivity(activity)}
    `;
  }

  return `
    <h2>Search Status</h2>
    <div class="summary-grid">
      ${summaryItem(counts.open, "Open")}
      ${summaryItem(counts.searching, "Searching")}
      ${summaryItem(counts.done, "Complete")}
    </div>
    ${renderMissingPersonSection()}
  `;
}

function renderCellPanel(id) {
  const entry = state.cells[id] || {};
  const statusKey = entry.status || "open";
  const status = STATUS[statusKey] || STATUS.open;
  const activeIncident = getOpenIncidentForGrid(id);
  const searchers = getSearchers(entry);
  const heartbeatAge = entry.lastHeartbeatAt ? formatRelativeAge(entry.lastHeartbeatAt) : "None";
  const staleEta = entry.status === "searching" ? getStaleEta(entry) : "";

  return `
    <button id="backBtn" class="button" type="button">Back</button>
    <h2 style="margin-top: 16px;">Grid ${id}</h2>
    <span class="status-pill ${status.className}">${status.label}</span>
    ${activeIncident ? `<p class="notice danger"><strong>${escapeHtml(activeIncident.type)}</strong>: ${escapeHtml(activeIncident.route)}</p>` : ""}

    ${renderSearcherList(searchers)}

    <dl class="meta-list">
      ${metaRow("People searching", String(searchers.length))}
      ${metaRow("Updated", entry.updatedAt ? formatTime(entry.updatedAt) : "Never")}
      ${metaRow("Last heartbeat", heartbeatAge)}
      ${staleEta ? metaRow("Auto-release", staleEta) : ""}
      ${_autoHeartbeatNote(id, entry) ? metaRow("Auto-heartbeat", _autoHeartbeatNote(id, entry)) : ""}
    </dl>

    <form id="cellForm" class="cell-form">
      <label>Your name
        <input id="cellName" autocomplete="name" value="${escapeAttr(state.profile.name)}" />
      </label>
      <div class="field-row">
        <label>Your phone
          <input id="cellContact" autocomplete="tel" value="${escapeAttr(state.profile.contact)}" />
        </label>
        <label>Your team
          <input id="cellTeam" value="${escapeAttr(state.profile.team)}" />
        </label>
      </div>
      <label>Notes
        <textarea id="cellNotes">${escapeHtml(entry.notes ?? "")}</textarea>
      </label>
    </form>

    ${renderCellClues(id)}

    ${state.profile.dispatcher ? _renderCellHistory(entry) : ""}

    <details class="status-dropdown" id="statusDropdown">
      <summary class="status-dropdown-toggle">Update status <span class="status-dropdown-chevron">▾</span></summary>
      <div class="status-grid">
        <button class="button primary" data-status="searching" type="button">Currently searching</button>
        <button class="button success" data-status="done" type="button">Search complete</button>
        <button class="button" data-status="stopped" type="button">Stopped</button>
        <button class="button warning" data-status="backup" type="button">Need backup</button>
        <button class="button danger" data-status="emergency" type="button">Emergency</button>
        <button class="button found" data-status="found" type="button">Found subject</button>
      </div>
    </details>
    <div class="button-row stack-space">
      <button id="heartbeatBtn" class="button full" type="button">Send heartbeat</button>
      ${
        state.profile.dispatcher || isOwnedByCurrentUser(entry)
          ? '<button id="releaseCellBtn" class="button warning full" type="button">Release grid</button>'
          : ""
      }
      ${
        state.profile.dispatcher || isOwnedByCurrentUser(entry)
          ? '<button id="clearCellBtn" class="button full" type="button">Clear grid (undo)</button>'
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
  document.getElementById("missingPersonForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    _saveMissingPerson();
  });
  document.getElementById("mpPhotoInput")?.addEventListener("change", _handleMissingPersonPhoto);
  document.getElementById("runStaleBtn")?.addEventListener("click", () => scanStaleCells({ manual: true }));
  document.getElementById("exportAuditBtn")?.addEventListener("click", exportAudit);
  document.getElementById("resetCellsBtn")?.addEventListener("click", _resetAllCells);
  document.getElementById("positionsKeyBtn")?.addEventListener("click", async () => {
    await savePositionsKey();
    loadVolunteerQueue();
  });
  document.getElementById("placeLastSeenBtn")?.addEventListener("click", togglePlaceLastSeen);
  document.getElementById("removeLastSeenBtn")?.addEventListener("click", removeLastSeen);
  document.getElementById("clearTrailBtn")?.addEventListener("click", clearLastSeenTrail);
  document.getElementById("lastSeenForm")?.addEventListener("submit", saveLastSeenDetails);
  document.getElementById("lastSeenPhotoInput")?.addEventListener("change", handleLastSeenPhoto);
  document.getElementById("lastSeenAddressForm")?.addEventListener("submit", geocodeLastSeen);

  document.querySelectorAll("[data-jump-grid]").forEach((button) => {
    button.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("esti:select-cell", { detail: button.dataset.jumpGrid }));
    });
  });
}

async function _resetAllCells() {
  if (!window.confirm("Reset all grid cells to open? This clears all statuses (searching, done, stale). Missing person info and clues are kept. This cannot be undone.")) return;
  try {
    showToast("Resetting grid…");
    const searchParam = SEARCH_ID ? `?s=${encodeURIComponent(SEARCH_ID)}` : "";
    const getRes = await fetch(`${SHARED_STATE_API}${searchParam}`, { cache: "no-store" });
    if (!getRes.ok) throw new Error(`Fetch failed: ${getRes.status}`);
    const { state: remote } = await getRes.json();
    const reset = { ...(remote || {}), cells: {}, updatedAt: Date.now() };
    const postRes = await fetch(SHARED_STATE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...reset, searchId: SEARCH_ID || undefined }),
    });
    if (!postRes.ok) throw new Error(`Save failed: ${postRes.status}`);
    await fetchSharedState({ initial: false });
    showToast("All cells reset to open.");
  } catch (err) {
    showToast(err.message || "Reset failed.");
  }
}

function bindCellPanel(id) {
  document.getElementById("backBtn").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("esti:deselect-cell"));
  });
  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", () => updateCell(id, button.dataset.status));
  });
  document.getElementById("heartbeatBtn").addEventListener("click", () => sendHeartbeat(id));
  document.getElementById("releaseCellBtn")?.addEventListener("click", () => releaseCell(id, "manual_release"));
  document.getElementById("clearCellBtn")?.addEventListener("click", () => clearCell(id));
  document.getElementById("resolveIncidentBtn")?.addEventListener("click", () => resolveIncidentForGrid(id));

  // Clue form
  let _cluePhotoData = "";
  document.getElementById("cluePhotoInput")?.addEventListener("change", async (e) => {
    const [file] = e.target.files;
    if (!file) return;
    try {
      _cluePhotoData = await _compressPhoto(file, 360, 0.72);
      document.getElementById("cluePhotoStatus").textContent = "Photo ready.";
    } catch { document.getElementById("cluePhotoStatus").textContent = "Photo failed."; }
  });
  document.getElementById("clueForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const type = document.getElementById("clueType")?.value || "other";
    const description = document.getElementById("clueDescription")?.value.trim() || "";
    const latlng = store.lastGpsFix;
    logClue({ gridId: id, type, description, lat: latlng?.lat, lng: latlng?.lng, photoData: _cluePhotoData });
    _cluePhotoData = "";
    showToast("Clue logged.");
  });
  document.querySelectorAll("[data-resolve-clue]").forEach((btn) => {
    btn.addEventListener("click", () => resolveClue(btn.dataset.resolveClue));
  });
}

// ---- Helpers ----

function _renderCellHistory(entry) {
  const history = Array.isArray(entry.history) ? entry.history : [];
  if (!history.length) return "";
  const rows = [...history].reverse().map((h) => {
    const s = STATUS[h.status] || STATUS.open;
    return `<li class="cell-history-row">
      <span class="status-pill ${s.className} cell-history-pill">${escapeHtml(s.label)}</span>
      <span class="cell-history-meta">${escapeHtml(formatTime(h.timestamp))} · ${escapeHtml(h.byName || "Unknown")}</span>
    </li>`;
  }).join("");
  return `
    <div class="divider"></div>
    <h3>Stage History</h3>
    <ul class="cell-history-list">${rows}</ul>`;
}

function summaryItem(count, label) {
  return `<div class="summary-item"><strong>${count}</strong><span>${label}</span></div>`;
}

function metricItem(value, label) {
  return `<div class="metric-item"><strong>${escapeHtml(String(value))}</strong><span>${label}</span></div>`;
}

function renderActivity(activity) {
  if (!activity.length) return '<p class="muted">No grid updates yet.</p>';
  return `
    <ul class="activity-list">
      ${activity.map((event) => `
        <li>
          <strong>${escapeHtml(event.grid)}</strong>
          ${escapeHtml(humanAction(event.actionType))}
          ${event.user?.name ? `by ${escapeHtml(event.user.name)}` : ""}
          <br />${formatTime(event.timestamp)}
        </li>`).join("")}
    </ul>`;
}

function renderSearcherList(searchers) {
  if (!searchers.length) return '<p class="notice">No volunteers on this grid yet. Tap "Keep searching" below to start.</p>';
  const noun = searchers.length === 1 ? "person" : "people";
  return `
    <div class="searcher-block">
      <p class="searcher-count">${searchers.length} ${noun} searching here</p>
      <ul class="searcher-list">
        ${searchers.map((entry) => {
          const isMe =
            (entry.userId && entry.userId === state.profile.userId) ||
            (entry.sessionId && entry.sessionId === session.id);
          return `<li>
            <strong>${escapeHtml(entry.name || "Volunteer")}</strong>${isMe ? ' <span class="you-pill">you</span>' : ""}
            ${entry.team ? `<span class="small">${escapeHtml(entry.team)}</span>` : ""}
          </li>`;
        }).join("")}
      </ul>
    </div>`;
}

function _autoHeartbeatNote(id, entry) {
  if (!store.gpsWatchId) return "";
  if (!isOwnedByCurrentUser(entry) || entry.status !== "searching") return "";
  if (store.gpsCellId !== id) return "Outside your grid — auto-heartbeat paused";
  const s = store.autoHeartbeatStatus;
  if (s === "poor_accuracy") return "GPS too weak for auto-heartbeat";
  if (s === "active") {
    const lastAt = store.lastAutoHeartbeatAtByCell[id];
    if (!lastAt) return "Auto-heartbeat active";
    const mins = Math.round((Date.now() - lastAt) / 60000);
    return mins < 1 ? "Active — recorded just now" : `Active — recorded ${mins} min ago`;
  }
  return "";
}

function metaRow(label, value) {
  return `<div class="meta-row"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

// ---- Clues ----

function renderCellClues(gridId) {
  const clues = getCluesForGrid(gridId);
  const typeOptions = CLUE_TYPES.map(
    ({ id, label }) => `<option value="${escapeAttr(id)}">${escapeHtml(label)}</option>`,
  ).join("");
  const clueList = clues.length
    ? `<ul class="clue-list">
        ${clues.map((c) => `
          <li class="clue-item${c.resolved ? " resolved" : ""}">
            <span class="clue-type">${escapeHtml(c.type)}</span>
            ${c.description ? `<span>${escapeHtml(c.description)}</span>` : ""}
            <small>${escapeHtml(c.loggedBy?.name || "Volunteer")}</small>
            ${!c.resolved && state.profile.dispatcher
              ? `<button class="link-button" type="button" data-resolve-clue="${escapeAttr(c.id)}">Resolve</button>`
              : ""}
          </li>`).join("")}
      </ul>`
    : '<p class="muted small">No clues logged for this grid yet.</p>';

  return `
    <div class="divider"></div>
    <h3>Clues (${clues.filter((c) => !c.resolved).length} open)</h3>
    ${clueList}
    <form id="clueForm" class="profile-form">
      <div class="field-row">
        <label>Type
          <select id="clueType">${typeOptions}</select>
        </label>
      </div>
      <label>Description
        <input id="clueDescription" autocomplete="off" placeholder="What was found and where exactly…" />
      </label>
      <div class="photo-upload-row">
        <label class="button full" style="cursor:pointer;text-align:center;">
          Add photo
          <input id="cluePhotoInput" type="file" accept="image/*" hidden />
        </label>
        <span id="cluePhotoStatus" class="muted small"></span>
      </div>
      <button class="button warning full" type="submit">Log clue</button>
    </form>
  `;
}

// ---- Missing Person ----

function renderMissingPersonSection() {
  const mp = state.missingPerson || defaultMissingPerson();
  const isDispatcher = state.profile.dispatcher;

  if (!isDispatcher) {
    if (!mp.name) return "";
    const catLabel = mp.category ? KOESTER_CATEGORIES.find((c) => c.id === mp.category)?.label || mp.category : null;
    const photoThumb = mp.photoData ? `<img src="${mp.photoData}" class="photo-thumb" alt="Missing person photo" />` : "";
    return `
      <div class="divider"></div>
      <h3>Missing Person</h3>
      <div class="mp-readonly">
        ${photoThumb}
        ${mp.name ? `<p class="mp-name">${escapeHtml(mp.name)}${mp.age ? `, age ${escapeHtml(mp.age)}` : ""}${mp.gender ? ` (${escapeHtml(mp.gender)})` : ""}</p>` : ""}
        ${catLabel ? `<p class="mp-detail"><span class="mp-key">Category</span> ${escapeHtml(catLabel)}</p>` : ""}
        ${mp.clothing ? `<p class="mp-detail"><span class="mp-key">Clothing</span> ${escapeHtml(mp.clothing)}</p>` : ""}
        ${mp.description ? `<p class="mp-detail"><span class="mp-key">Description</span> ${escapeHtml(mp.description)}</p>` : ""}
        ${mp.medicalNotes ? `<p class="mp-detail"><span class="mp-key">Medical</span> ${escapeHtml(mp.medicalNotes)}</p>` : ""}
      </div>
    `;
  }

  const categoryOptions = KOESTER_CATEGORIES.map(
    ({ id, label }) =>
      `<option value="${escapeAttr(id)}" ${mp.category === id ? "selected" : ""}>${escapeHtml(label)}</option>`,
  ).join("");
  const photoThumb = mp.photoData
    ? `<img src="${mp.photoData}" class="photo-thumb" alt="Missing person photo" />`
    : "";

  return `
    <div class="divider"></div>
    <h3>Missing Person</h3>
    <form id="missingPersonForm" class="profile-form">
      <div class="photo-upload-row">
        ${photoThumb}
        <label class="button full" style="cursor:pointer;text-align:center;">
          ${mp.photoData ? "Replace photo" : "Upload photo"}
          <input id="mpPhotoInput" type="file" accept="image/*" hidden />
        </label>
      </div>
      <label>Full name
        <input id="mpName" autocomplete="off" value="${escapeAttr(mp.name)}" placeholder="Name" />
      </label>
      <div class="field-row">
        <label>Age
          <input id="mpAge" inputmode="numeric" value="${escapeAttr(mp.age)}" placeholder="e.g. 72" />
        </label>
        <label>Gender
          <input id="mpGender" value="${escapeAttr(mp.gender)}" placeholder="e.g. Male" />
        </label>
      </div>
      <label>Category
        <select id="mpCategory">
          <option value="">— select —</option>
          ${categoryOptions}
        </select>
      </label>
      <label>Physical description
        <textarea id="mpDescription" rows="2" placeholder="Height, build, distinguishing features…">${escapeHtml(mp.description)}</textarea>
      </label>
      <label>Clothing
        <textarea id="mpClothing" rows="2" placeholder="What they were wearing when last seen…">${escapeHtml(mp.clothing)}</textarea>
      </label>
      <label>Medical / behavioural notes
        <textarea id="mpMedical" rows="2" placeholder="Conditions, medications, typical behaviours…">${escapeHtml(mp.medicalNotes)}</textarea>
      </label>
      <div class="button-row">
        <button class="button full" type="submit">Save profile</button>
      </div>
    </form>
    ${mp.category ? `<p class="notice success small">Koester rings shown on map (${KOESTER_CATEGORIES.find((c) => c.id === mp.category)?.label || mp.category}).</p>` : ""}
  `;
}

function renderWhatsAppShare() {
  const mp = state.missingPerson || defaultMissingPerson();
  if (!mp.name) return "";
  const url = window.location.href;
  const lines = [
    `🔍 *SEARCH ACTIVE — ESTI*`,
    mp.name ? `*Missing:* ${mp.name}${mp.age ? `, age ${mp.age}` : ""}${mp.gender ? ` (${mp.gender})` : ""}` : null,
    mp.clothing ? `*Clothing:* ${mp.clothing}` : null,
    mp.description ? `*Description:* ${mp.description}` : null,
    mp.medicalNotes ? `*Notes:* ${mp.medicalNotes}` : null,
    `\n*Live map:* ${url}`,
  ].filter(Boolean).join("\n");
  const encoded = encodeURIComponent(lines);
  return `
    <a class="button success full" href="https://wa.me/?text=${encoded}" target="_blank" rel="noopener">Share on WhatsApp</a>
  `;
}

// ---- Profile actions ----

function _saveMissingPerson() {
  const prev = state.missingPerson?.category || "";
  state.missingPerson = {
    name: document.getElementById("mpName")?.value.trim() || "",
    age: document.getElementById("mpAge")?.value.trim() || "",
    gender: document.getElementById("mpGender")?.value.trim() || "",
    category: document.getElementById("mpCategory")?.value || "",
    description: document.getElementById("mpDescription")?.value.trim() || "",
    clothing: document.getElementById("mpClothing")?.value.trim() || "",
    medicalNotes: document.getElementById("mpMedical")?.value.trim() || "",
    photoData: state.missingPerson?.photoData || "",
  };
  addAudit("missing_person_updated", null, { name: state.missingPerson.name, category: state.missingPerson.category });
  saveState();
  // Re-render Koester rings when category changes.
  if (prev !== state.missingPerson.category) {
    document.dispatchEvent(new CustomEvent("esti:render-last-seen"));
  }
  renderPanel();
  showToast("Missing person profile saved.");
}

async function _handleMissingPersonPhoto(event) {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const dataUrl = await _compressPhoto(file, 360, 0.72);
    if (!state.missingPerson) state.missingPerson = defaultMissingPerson();
    state.missingPerson.photoData = dataUrl;
    addAudit("missing_person_photo_set", null, {});
    saveState();
    renderPanel();
    showToast("Photo saved.");
  } catch {
    showToast("Could not load that image.");
  }
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

