import { DISPATCHER_PIN, SHARED_API_BASE, SEARCH_ID, POSITIONS_KEY_STORE, SEARCH_AREA, SEARCH_AREA_EXTENDED } from "../core/constants.js";
import { state, saveState } from "../core/state.js";
import { store } from "../core/store.js";
import { addAudit } from "../core/audit.js";
import { getOpenIncidents } from "../grid/incidents.js";
import { getCellsByStatus } from "../grid/cells.js";
import { renderLastSeenControl, enterCellPickingMode, exitCellPickingMode } from "./map.js";
import { escapeHtml, escapeAttr, formatTime } from "../utils/format.js";
import { showToast } from "../utils/toast.js";

const INTAKE_API = `${SHARED_API_BASE}/api/intake`;

// Module-level cache — survives panel re-renders so there's no flicker.
let _cachedVolunteers = [];
let _lastQueueFetch = 0;

export function renderDispatcherDashboard() {
  const staleCells = getCellsByStatus("stale");
  const activeCells = getCellsByStatus("searching");
  const incidents = getOpenIncidents();
  const audit = state.audit.slice(-12).reverse();
  return `
    <section id="dispatcherDashboard" class="dispatcher-dashboard" tabindex="-1" aria-live="polite">
      <div class="divider"></div>
      <h3>Dispatcher</h3>
      <p class="notice success"><strong>Dispatcher mode active.</strong> Use the top button to exit dispatch mode.</p>
      ${renderSearchControl()}
      ${renderLocationKeyControl()}
      ${renderLastSeenControl()}
      <div class="button-row">
        <button id="runStaleBtn" class="button warning" type="button">Run stale release</button>
        <button id="exportAuditBtn" class="button" type="button">Export audit</button>
      </div>
      <div class="button-row">
        <button id="resetCellsBtn" class="button danger" type="button">Reset all cells</button>
      </div>
      <h3>Volunteer Queue</h3>
      <div id="volunteerQueue">${_renderQueueContents()}</div>
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

function _renderQueueContents() {
  if (!store.positionsKey) return '<p class="muted">Enter location key above to load volunteer queue.</p>';
  if (!_cachedVolunteers.length) return '<p class="muted">No volunteers registered yet.</p>';
  return `<ul class="volunteer-queue-list">${_cachedVolunteers.map(_renderVolunteerRow).join("")}</ul>`;
}

// Called by panel.js after bindCommandPanel so queue actions work immediately.
export function bindVolunteerQueueActions() {
  const container = document.getElementById("volunteerQueue");
  if (container) _bindQueueActions(container);
}

export async function loadVolunteerQueue(force = false) {
  const container = document.getElementById("volunteerQueue");
  if (!store.positionsKey) return;
  const now = Date.now();
  if (!force && now - _lastQueueFetch < 8000) return;
  _lastQueueFetch = now;
  try {
    const searchParam = SEARCH_ID ? `?s=${encodeURIComponent(SEARCH_ID)}` : "";
    const res = await fetch(`${INTAKE_API}${searchParam}`, {
      headers: { "x-positions-key": store.positionsKey },
    });
    if (!res.ok) return;
    const data = await res.json();
    _cachedVolunteers = Array.isArray(data.volunteers) ? data.volunteers : [];
    if (container) {
      container.innerHTML = _renderQueueContents();
      _bindQueueActions(container);
    }
    // Rebuild assigned-cells overlay so the map highlights reserved squares.
    const assigned = new Map();
    _cachedVolunteers.forEach((v) => {
      if (v.assignedCell && v.status !== "completed" && v.status !== "found") {
        assigned.set(v.assignedCell, `${v.firstName} ${v.lastName}`.trim());
      }
    });
    store.assignedCells = assigned;
    document.dispatchEvent(new CustomEvent("esti:grid-update"));
  } catch { /* silent — stale cache stays visible */ }
}

function _renderVolunteerRow(v) {
  const name = escapeHtml(`${v.firstName} ${v.lastName}`);
  const phone = escapeHtml(v.phone || "");
  const status = escapeHtml(v.status || "queued");
  const cell = v.assignedCell ? escapeHtml(v.assignedCell) : null;
  const emailLink = v.email && v.trackingUrl && v.assignedCell ? buildEmailLink(v) : "";
  const canAssign = v.status !== "completed" && v.status !== "found";

  const latestNote = Array.isArray(v.notes) && v.notes.length
    ? v.notes[v.notes.length - 1]
    : null;
  const noteHtml = latestNote
    ? `<div class="vq-note"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;flex-shrink:0"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${escapeHtml(latestNote.text)}</div>`
    : "";

  const urgentBanner = v.status === "backup_needed"
    ? `<div class="vq-urgent"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Backup requested</div>`
    : v.status === "found"
    ? `<div class="vq-urgent vq-urgent-found"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>Missing person found</div>`
    : "";

  const smsLink = v.phone && v.trackingUrl && v.assignedCell ? buildSmsLink(v) : "";

  return `
    <li class="volunteer-queue-row" data-vol-id="${escapeAttr(v.id)}">
      ${urgentBanner}
      <div class="vq-name">${name}</div>
      <div class="vq-meta">
        ${phone ? `<a href="tel:${escapeAttr(v.phone)}" class="vq-call">${phone}</a>` : ""}
        <span class="vq-status status-pill ${_statusClass(v.status)}">${status}</span>
        ${cell ? `<span class="vq-cell">Grid ${cell}</span>` : ""}
      </div>
      ${noteHtml}
      <div class="vq-actions">
        ${canAssign ? `<button class="button small vq-assign-btn" data-vol-id="${escapeAttr(v.id)}" type="button">${cell ? "Change grid" : "Assign grid"}</button>` : ""}
        ${cell && canAssign ? `<button class="button small vq-remove-btn" data-vol-id="${escapeAttr(v.id)}" type="button">Remove</button>` : ""}
        ${smsLink   ? `<a href="${escapeAttr(smsLink)}"   class="button primary small vq-send">SMS</a>` : ""}
        ${emailLink ? `<a href="${escapeAttr(emailLink)}" class="button small vq-send">Email</a>` : ""}
        ${v.assignedCell && v.trackingUrl ? `<button class="button small vq-copy-btn" data-vol-id="${escapeAttr(v.id)}" type="button">Copy</button>` : ""}
      </div>
    </li>
  `;
}

function _bindQueueActions(container) {
  container.querySelectorAll(".vq-assign-btn").forEach((btn) => {
    btn.addEventListener("click", () => _showAssignForm(btn.dataset.volId, container));
  });
  container.querySelectorAll(".vq-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => _removeAssignment(btn.dataset.volId, container));
  });
  container.querySelectorAll(".vq-copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => _copyAssignmentText(btn.dataset.volId, btn));
  });
}

function _showAssignForm(volunteerId, container) {
  // Cancel any existing pick in progress.
  _cancelPickMode();

  const v = _cachedVolunteers.find((x) => x.id === volunteerId);
  if (!v) return;

  const name = `${v.firstName} ${v.lastName}`;
  store.assigningVolunteerId = volunteerId;
  store.assigningVolunteerName = name;
  enterCellPickingMode(name);

  // Mark the row so the user sees which volunteer is being assigned.
  const row = container.querySelector(`[data-vol-id="${volunteerId}"]`);
  const pill = document.createElement("span");
  pill.id = "vq-picking-pill";
  pill.className = "vq-picking-pill";
  pill.textContent = "Tap a cell on the map…";
  row?.querySelector(".vq-actions")?.prepend(pill);

  function onPicked(e) {
    cleanup();
    _submitAssign(volunteerId, String(e.detail).toUpperCase(), container);
  }
  function onCancelled() { cleanup(); }

  function cleanup() {
    document.removeEventListener("esti:cell-picked", onPicked);
    document.removeEventListener("esti:cell-pick-cancelled", onCancelled);
    exitCellPickingMode();
    document.getElementById("vq-picking-pill")?.remove();
  }

  document.addEventListener("esti:cell-picked", onPicked, { once: true });
  document.addEventListener("esti:cell-pick-cancelled", onCancelled, { once: true });
}

function _cancelPickMode() {
  // If a pick was already in progress, clean up before starting a new one.
  if (store.assigningVolunteerId) {
    document.dispatchEvent(new CustomEvent("esti:cell-pick-cancelled"));
  }
}

async function _submitAssign(volunteerId, cellId, container) {
  showToast(`Assigning ${cellId}…`);
  try {
    const searchParam = SEARCH_ID || "default";

    // Resolve cell center coords and bbox from the live grid lookup.
    const feature = store.cellLookup.get(cellId);
    const center = feature?.properties?.center || null;
    let assignedCellBounds = null;
    if (feature && window.turf) {
      const [w, s, e, n] = window.turf.bbox(feature);
      assignedCellBounds = [[s, w], [n, e]]; // Leaflet [[sw], [ne]] format
    }

    const res = await fetch(INTAKE_API, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        volunteerId,
        assignedCell: cellId,
        assignedCellCoords: center,
        assignedCellBounds,
        searchId: searchParam,
        dispatchKey: store.positionsKey,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Save failed");
    showToast(`Assigned ${cellId} — tap SMS or Email to notify.`);
    _lastQueueFetch = 0;
    await loadVolunteerQueue(true);
  } catch (err) {
    showToast(err.message || "Could not save assignment.");
  }
}

async function _removeAssignment(volunteerId, container) {
  showToast("Removing assignment…");
  try {
    const searchParam = SEARCH_ID || "default";
    const res = await fetch(INTAKE_API, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        volunteerId,
        assignedCell: "",
        searchId: searchParam,
        dispatchKey: store.positionsKey,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Remove failed");
    showToast("Assignment removed.");
    _lastQueueFetch = 0;
    await loadVolunteerQueue(true);
  } catch (err) {
    showToast(err.message || "Could not remove assignment.");
  }
}

function _buildAssignmentText(v) {
  const name = `${v.firstName} ${v.lastName}`;
  const trackingUrl = _trackingUrlForVolunteer(v);
  const mapsUrl = v.assignedCellCoords
    ? `https://maps.google.com/?q=${v.assignedCellCoords[1]},${v.assignedCellCoords[0]}`
    : "";
  return [
    `Hi ${name}, you've been assigned to grid ${v.assignedCell} for the search.`,
    mapsUrl ? `Navigate: ${mapsUrl}` : "",
    `Your tracking link (keep open during search): ${trackingUrl}`,
  ].filter(Boolean).join("\n");
}

function _trackingUrlForVolunteer(v) {
  if (!v.trackingUrl) return "";
  try {
    const url = new URL(v.trackingUrl, window.location.origin);
    const searchId = v.searchId || SEARCH_ID || "default";
    if (!url.searchParams.get("s")) url.searchParams.set("s", searchId);
    return url.toString();
  } catch {
    return v.trackingUrl;
  }
}

async function _copyAssignmentText(volunteerId, btn) {
  const v = _cachedVolunteers.find((x) => x.id === volunteerId);
  if (!v) return;
  try {
    await navigator.clipboard.writeText(_buildAssignmentText(v));
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = orig; }, 2000);
  } catch {
    showToast("Could not copy — try SMS or Email instead.");
  }
}

function buildSmsLink(v) {
  return `sms:${v.phone.replace(/[^\d+]/g, "")}?body=${encodeURIComponent(_buildAssignmentText(v))}`;
}

function buildEmailLink(v) {
  const name = `${v.firstName} ${v.lastName}`;
  const trackingUrl = _trackingUrlForVolunteer(v);
  const mapsUrl = v.assignedCellCoords
    ? `https://maps.google.com/?q=${v.assignedCellCoords[1]},${v.assignedCellCoords[0]}`
    : "";
  const subject = `Search assignment — Grid ${v.assignedCell}`;
  const body = [
    `Hi ${name},`,
    ``,
    `You've been assigned to grid ${v.assignedCell} for the search.`,
    mapsUrl ? `Navigate here: ${mapsUrl}` : "",
    ``,
    `Open your tracking page and keep it open during your search:`,
    trackingUrl,
  ].filter((l) => l !== undefined).join("\n");
  return `mailto:${encodeURIComponent(v.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function _statusClass(status) {
  if (status === "backup_needed") return "status-backup";
  if (status === "found") return "status-found";
  if (status === "assigned") return "status-searching";
  if (status === "completed") return "status-done";
  return "status-open";
}

export function renderDispatcherLogin() {
  return `
    <button id="dispatcherCancelBtn" class="button" type="button">Back</button>
    <div class="login-card">
      <span class="login-badge">Restricted</span>
      <h2>Dispatcher Login</h2>
      <p class="muted">Dispatcher mode unlocks the command tools — stale release, audit export, the incident log, and the live volunteer map.</p>
      <form id="dispatcherLoginForm" class="login-form">
        <label>Dispatcher PIN
          <input id="dispatcherPin" inputmode="numeric" autocomplete="off" placeholder="Enter PIN" />
        </label>
        <p id="dispatcherLoginError" class="notice danger" hidden></p>
        <button class="button primary full" type="submit">Enter dispatcher mode</button>
      </form>
    </div>
  `;
}

export function bindDispatcherLogin() {
  document.getElementById("dispatcherLoginForm").addEventListener("submit", enterDispatcherMode);
  document.getElementById("dispatcherCancelBtn").addEventListener("click", () => {
    store.dispatcherLoginOpen = false;
    document.dispatchEvent(new CustomEvent("esti:dispatcher-mode-changed"));
  });
  requestAnimationFrame(() => document.getElementById("dispatcherPin")?.focus());
}

export async function enterDispatcherMode(event) {
  event?.preventDefault();
  const pinInput = document.getElementById("dispatcherPin");
  const pin = pinInput.value.trim();
  if (pin !== DISPATCHER_PIN) {
    addAudit("dispatcher_login_failed", null, {});
    saveState();
    const error = document.getElementById("dispatcherLoginError");
    if (error) { error.textContent = "That PIN didn't match. Try again."; error.hidden = false; }
    pinInput.value = "";
    pinInput.focus();
    return;
  }

  // Best-effort: fetch positions key from server so volunteer map unlocks automatically.
  try {
    const res = await fetch(`${window.location.origin}/api/dispatcher-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (data.ok && data.positionsKey) {
      store.positionsKey = data.positionsKey;
      localStorage.setItem(POSITIONS_KEY_STORE, data.positionsKey);
    }
  } catch { /* silent — positions key can be entered manually */ }

  store.dispatcherLoginOpen = false;
  state.profile.dispatcher = true;
  state.profile.role = "dispatcher";
  addAudit("dispatcher_mode_enabled", null, {});
  saveState();
  document.dispatchEvent(new CustomEvent("esti:dispatcher-mode-changed"));
  showToast("Dispatcher mode on. Dashboard is open.");
}

export function renderLocationKeyControl() {
  const unlocked = Boolean(store.positionsKey);
  return `
    <h3>Live volunteer map</h3>
    <p class="muted tight">Volunteer GPS locations are private. Enter the dispatcher location key to show them on the map.</p>
    <div class="verification-row">
      <label>Location key
        <input id="positionsKeyInput" type="password" autocomplete="off" value="${escapeAttr(store.positionsKey)}" />
      </label>
      <button id="positionsKeyBtn" class="button active" type="button">${unlocked ? "Update" : "Unlock"}</button>
    </div>
    ${unlocked ? '<p class="notice success">Location feed unlocked on this device.</p>' : ""}
  `;
}

function renderIncidentList(incidents) {
  if (!incidents.length) return '<p class="muted">No open incidents.</p>';
  return `
    <ul class="incident-list">
      ${incidents
        .map(
          (incident) => `
          <li>
            <strong>${escapeHtml(incident.grid)} ${escapeHtml(incident.type)}</strong>
            <span>${escapeHtml(incident.route)}</span>
            <small>${formatTime(incident.createdAt)} by ${escapeHtml(incident.createdBy?.name || "unknown")}</small>
          </li>`,
        )
        .join("")}
    </ul>
  `;
}

function renderAuditLog(audit) {
  if (!audit.length) return '<p class="muted">No audit events yet.</p>';
  return `
    <ul class="audit-list">
      ${audit
        .map(
          (event) => `
          <li>
            <strong>${escapeHtml(_humanAction(event.actionType))}</strong>
            ${event.grid ? `grid ${escapeHtml(event.grid)}` : "system"}
            <small>${formatTime(event.timestamp)} / ${escapeHtml(event.user?.name || event.user?.userId || "system")}</small>
          </li>`,
        )
        .join("")}
    </ul>
  `;
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
                  `<li><button class="link-button" type="button" data-jump-grid="${escapeAttr(cell.id)}">${escapeHtml(cell.id)}</button> ${escapeHtml(cell.name || "unassigned")}</li>`,
              )
              .join("")}</ul>`
          : '<p class="muted">None</p>'
      }
    </div>
  `;
}

function _humanAction(actionType) {
  return actionType.replaceAll("_", " ");
}

function renderSearchControl() {
  const searchName = state.search?.label || state.search?.orgName || (SEARCH_ID ? `Search ${SEARCH_ID}` : "Default operation");
  return `
    <div class="search-control">
      <div class="search-control-header">
        <span class="label-text">Active Search</span>
        <strong class="search-control-name">${escapeHtml(searchName)}</strong>
        ${SEARCH_ID ? `<span class="search-id-chip">${escapeHtml(SEARCH_ID)}</span>` : ""}
      </div>
      <div class="search-control-actions">
        <button id="switchSearchBtn" class="button small" type="button">Switch search</button>
        <button id="newSearchBtn" class="button small primary" type="button">+ New search</button>
      </div>
      <div id="searchSwitcherPanel" ${store.searchSwitcherOpen ? "" : "hidden"}>${store.searchSwitcherOpen ? '<p class="muted">Loading searches…</p>' : ""}</div>
      <div id="newSearchPanel" ${store.newSearchOpen ? "" : "hidden"}>${renderNewSearchForm()}</div>
    </div>
  `;
}

function renderNewSearchForm() {
  return `
    <form id="newSearchForm" class="new-search-form">
      <h4>Create New Search</h4>
      <label>Organization name
        <input id="nsOrgName" type="text" placeholder="e.g. Shomrim Toronto" autocomplete="off" />
      </label>
      <label>Search label / location
        <input id="nsLabel" type="text" placeholder="e.g. Bathurst & Wilson area" autocomplete="off" />
      </label>
      <label>Search area
        <select id="nsBoundary">
          <option value="primary">Toronto Primary (Keele / Yonge / Steeles / Eglinton)</option>
          <option value="extended">Toronto Extended (DVP / Hwy 400 / Bloor / Hwy 407)</option>
        </select>
      </label>
      <div class="button-row">
        <button type="submit" class="button primary" id="nsSubmitBtn">Create & Switch</button>
        <button type="button" class="button" id="nsCancelBtn">Cancel</button>
      </div>
      <p id="nsError" class="notice danger" hidden></p>
    </form>
  `;
}

export function bindDispatcherDashboard() {
  const switchBtn = document.getElementById("switchSearchBtn");
  const newBtn = document.getElementById("newSearchBtn");
  const switchPanel = document.getElementById("searchSwitcherPanel");
  const newPanel = document.getElementById("newSearchPanel");

  async function _loadSwitcherContent() {
    switchPanel.innerHTML = '<p class="muted">Loading searches…</p>';
    switchPanel.hidden = false;
    try {
      const res = await fetch(`${SHARED_API_BASE}/api/searches`, { cache: "no-store" });
      const data = await res.json();
      const searches = Array.isArray(data.searches) ? data.searches : [];
      if (!searches.length) { switchPanel.innerHTML = '<p class="muted">No other searches found.</p>'; return; }
      switchPanel.innerHTML = `
        <select id="searchSelectList" class="search-select">
          ${searches.map((s) => `<option value="${escapeAttr(s.searchId)}" ${s.searchId === SEARCH_ID ? "selected" : ""}>${escapeHtml(s.label || s.orgName || s.searchId)}</option>`).join("")}
        </select>
        <button id="goToSearchBtn" class="button primary small" type="button">Go</button>
      `;
      document.getElementById("goToSearchBtn")?.addEventListener("click", () => {
        const sel = document.getElementById("searchSelectList");
        const id = sel?.value;
        if (id) window.location.href = `/dispatch?s=${encodeURIComponent(id)}`;
      });
    } catch {
      switchPanel.innerHTML = '<p class="muted">Could not load searches.</p>';
    }
  }

  // If switcher was open before this re-render, reload its content immediately.
  if (store.searchSwitcherOpen) _loadSwitcherContent();

  switchBtn?.addEventListener("click", () => {
    store.searchSwitcherOpen = !store.searchSwitcherOpen;
    store.newSearchOpen = false;
    newPanel.hidden = true;
    if (store.searchSwitcherOpen) {
      _loadSwitcherContent();
    } else {
      switchPanel.hidden = true;
    }
  });

  newBtn?.addEventListener("click", () => {
    store.newSearchOpen = !store.newSearchOpen;
    store.searchSwitcherOpen = false;
    switchPanel.hidden = true;
    newPanel.hidden = !store.newSearchOpen;
  });

  document.getElementById("nsCancelBtn")?.addEventListener("click", () => {
    store.newSearchOpen = false;
    newPanel.hidden = true;
  });

  document.getElementById("newSearchForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("nsSubmitBtn");
    const errEl = document.getElementById("nsError");
    const orgName = document.getElementById("nsOrgName")?.value.trim() || "";
    const label = document.getElementById("nsLabel")?.value.trim() || "";
    const boundaryChoice = document.getElementById("nsBoundary")?.value;
    const boundary = boundaryChoice === "extended" ? SEARCH_AREA_EXTENDED.boundary : SEARCH_AREA.boundary;

    btn.disabled = true;
    btn.textContent = "Creating…";
    errEl.hidden = true;
    try {
      const res = await fetch(`${SHARED_API_BASE}/api/searches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgName, label, boundary, cellKm: 0.5 }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Create failed");
      store.newSearchOpen = false;
      window.location.href = `/dispatch?s=${encodeURIComponent(data.searchId)}`;
    } catch (err) {
      errEl.textContent = err.message || "Could not create search.";
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = "Create & Switch";
    }
  });
}
