import { DISPATCHER_PIN, SHARED_API_BASE, SEARCH_ID } from "../core/constants.js";
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
      ${renderLocationKeyControl()}
      ${renderLastSeenControl()}
      <div class="button-row">
        <button id="runStaleBtn" class="button warning" type="button">Run stale release</button>
        <button id="exportAuditBtn" class="button" type="button">Export audit</button>
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
  } catch { /* silent — stale cache stays visible */ }
}

function _renderVolunteerRow(v) {
  const name = escapeHtml(`${v.firstName} ${v.lastName}`);
  const phone = escapeHtml(v.phone || "");
  const status = escapeHtml(v.status || "queued");
  const cell = v.assignedCell ? escapeHtml(v.assignedCell) : null;
  const smsLink = v.phone && v.trackingUrl && v.assignedCell ? buildSmsLink(v) : "";
  const canAssign = v.status !== "completed";

  return `
    <li class="volunteer-queue-row" data-vol-id="${escapeAttr(v.id)}">
      <div class="vq-name">${name}</div>
      <div class="vq-meta">
        ${phone ? `<a href="tel:${escapeAttr(v.phone)}" class="vq-call">${phone}</a>` : ""}
        <span class="vq-status status-pill ${_statusClass(v.status)}">${status}</span>
        ${cell ? `<span class="vq-cell">Grid ${cell}</span>` : ""}
      </div>
      <div class="vq-actions">
        ${canAssign ? `<button class="button small vq-assign-btn" data-vol-id="${escapeAttr(v.id)}" type="button">${cell ? "Change grid" : "Assign grid"}</button>` : ""}
        ${smsLink ? `<a href="${escapeAttr(smsLink)}" class="button primary small vq-send">Send SMS</a>` : ""}
      </div>
    </li>
  `;
}

function _bindQueueActions(container) {
  container.querySelectorAll(".vq-assign-btn").forEach((btn) => {
    btn.addEventListener("click", () => _showAssignForm(btn.dataset.volId, container));
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
    const res = await fetch(INTAKE_API, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        volunteerId,
        assignedCell: cellId,
        searchId: searchParam,
        dispatchKey: store.positionsKey,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Save failed");
    showToast(`Assigned ${cellId} — tap "Send SMS" to notify.`);
    _lastQueueFetch = 0;
    await loadVolunteerQueue(true);
  } catch (err) {
    showToast(err.message || "Could not save assignment.");
  }
}

function buildSmsLink(v) {
  const name = `${v.firstName} ${v.lastName}`;
  const mapsUrl = v.assignedCellCoords
    ? `https://maps.google.com/?q=${v.assignedCellCoords[1]},${v.assignedCellCoords[0]}`
    : "";
  const body = [
    `Hi ${name}, you've been assigned to grid ${v.assignedCell} for the search.`,
    mapsUrl ? `Navigate here: ${mapsUrl}` : "",
    `Open your tracking page (keep this page open during your search): ${v.trackingUrl}`,
  ].filter(Boolean).join("\n");
  return `sms:${v.phone.replace(/[^\d+]/g, "")}?body=${encodeURIComponent(body)}`;
}

function _statusClass(status) {
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

export function enterDispatcherMode(event) {
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
