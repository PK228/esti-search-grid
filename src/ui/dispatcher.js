import { DISPATCHER_PIN, SHARED_API_BASE, SEARCH_ID } from "../core/constants.js";
import { state, saveState } from "../core/state.js";
import { store } from "../core/store.js";
import { addAudit } from "../core/audit.js";
import { getOpenIncidents } from "../grid/incidents.js";
import { getCellsByStatus } from "../grid/cells.js";
import { renderLastSeenControl } from "./map.js";
import { escapeHtml, escapeAttr, formatTime } from "../utils/format.js";
import { showToast } from "../utils/toast.js";

const INTAKE_API = `${SHARED_API_BASE}/api/intake`;

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
      <div id="volunteerQueue"><p class="muted">Enter location key above to load volunteer queue.</p></div>
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

export async function loadVolunteerQueue() {
  const container = document.getElementById("volunteerQueue");
  if (!container || !store.positionsKey) return;
  try {
    const searchParam = SEARCH_ID ? `?s=${encodeURIComponent(SEARCH_ID)}` : "";
    const res = await fetch(`${INTAKE_API}${searchParam}`, {
      headers: { "x-positions-key": store.positionsKey },
    });
    if (!res.ok) { container.innerHTML = '<p class="muted">Could not load queue.</p>'; return; }
    const data = await res.json();
    const volunteers = Array.isArray(data.volunteers) ? data.volunteers : [];
    if (!volunteers.length) { container.innerHTML = '<p class="muted">No volunteers registered yet.</p>'; return; }
    container.innerHTML = renderVolunteerQueue(volunteers);
  } catch {
    container.innerHTML = '<p class="muted">Queue unavailable — check connection.</p>';
  }
}

function renderVolunteerQueue(volunteers) {
  return `
    <ul class="volunteer-queue-list">
      ${volunteers.map((v) => renderVolunteerRow(v)).join("")}
    </ul>
  `;
}

function renderVolunteerRow(v) {
  const name = escapeHtml(`${v.firstName} ${v.lastName}`);
  const phone = escapeHtml(v.phone || "");
  const status = escapeHtml(v.status || "queued");
  const cell = v.assignedCell ? escapeHtml(v.assignedCell) : null;

  const smsLink = v.phone && v.trackingUrl && v.assignedCell
    ? buildSmsLink(v)
    : "";

  return `
    <li class="volunteer-queue-row">
      <div class="vq-name">${name}</div>
      <div class="vq-meta">
        ${phone ? `<a href="tel:${escapeAttr(v.phone)}" class="vq-call">${phone}</a>` : ""}
        <span class="vq-status status-pill ${_statusClass(v.status)}">${status}</span>
        ${cell ? `<span class="vq-cell">Grid ${cell}</span>` : ""}
      </div>
      ${smsLink ? `<a href="${escapeAttr(smsLink)}" class="button primary vq-send">Send Assignment</a>` : ""}
    </li>
  `;
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
