import { DISPATCHER_PIN } from "../core/constants.js";
import { state, saveState } from "../core/state.js";
import { store } from "../core/store.js";
import { addAudit } from "../core/audit.js";
import { getOpenIncidents } from "../grid/incidents.js";
import { getCellsByStatus } from "../grid/cells.js";
import { renderLastSeenControl } from "./map.js";
import { escapeHtml, escapeAttr, formatTime } from "../utils/format.js";
import { showToast } from "../utils/toast.js";

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
