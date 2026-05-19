import { state } from "../core/state.js";
import { store } from "../core/store.js";
import { escapeHtml, escapeAttr, formatTime } from "../utils/format.js";
import { showToast } from "../utils/toast.js";
import {
  ZONE_DEFINITIONS, ZONE_BY_ID, NEIGHBORHOODS, ZONE_STATUSES,
  getZoneState, updateZone, getZoneStats, filterZones, submitMissingStreet,
} from "../grid/zones.js";

const PRIORITY_ORDER = { Critical: 0, High: 1, Standard: 2 };
const PRIORITY_CLASS = { Critical: "priority-critical", High: "priority-high", Standard: "priority-standard" };

export function renderZonePanel() {
  const stats = getZoneStats();
  const pct = Math.round((stats.COMPLETED / stats.total) * 100);
  const f = store.zoneFilter;

  const filtered = filterZones(f).sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2),
  );

  const neighborhoodOptions = NEIGHBORHOODS.map(
    n => `<option value="${escapeAttr(n)}" ${f.neighborhood === n ? "selected" : ""}>${escapeHtml(n)}</option>`,
  ).join("");

  const statusOptions = ZONE_STATUSES.map(
    s => `<option value="${escapeAttr(s.id)}" ${f.status === s.id ? "selected" : ""}>${escapeHtml(s.label)}</option>`,
  ).join("");

  const priorityOptions = ["Critical", "High", "Standard"].map(
    p => `<option value="${escapeAttr(p)}" ${f.priority === p ? "selected" : ""}>${escapeHtml(p)}</option>`,
  ).join("");

  return `
    <div class="zone-panel-header">
      <button id="zoneBackBtn" class="button" type="button">Back</button>
      <h2>Search Zones</h2>
    </div>

    <div class="zone-stats-row">
      <div class="zone-stat"><strong>${stats.COMPLETED}</strong><span>Completed</span></div>
      <div class="zone-stat"><strong>${stats.IN_PROGRESS}</strong><span>In Progress</span></div>
      <div class="zone-stat"><strong>${stats.REVISIT_REQUIRED}</strong><span>Revisit</span></div>
      <div class="zone-stat"><strong>${stats.UNASSIGNED}</strong><span>Unassigned</span></div>
    </div>
    <div class="zone-progress-bar">
      <div class="zone-progress-fill" style="width:${pct}%"></div>
      <span class="zone-progress-label">${pct}% complete (${stats.total} zones, ~${stats.totalHomes.toLocaleString()} homes)</span>
    </div>

    <div class="zone-filters">
      <input id="zoneSearchInput" class="zone-search" placeholder="Street or zone ID…" value="${escapeAttr(f.query)}" />
      <div class="zone-filter-row">
        <select id="zoneNeighborFilter">
          <option value="">All neighbourhoods</option>
          ${neighborhoodOptions}
        </select>
        <select id="zonePriorityFilter">
          <option value="">All priorities</option>
          ${priorityOptions}
        </select>
        <select id="zoneStatusFilter">
          <option value="">All statuses</option>
          ${statusOptions}
        </select>
      </div>
    </div>

    <p class="muted small zone-count">${filtered.length} zone${filtered.length !== 1 ? "s" : ""}</p>

    <ul class="zone-list">
      ${filtered.map(renderZoneRow).join("")}
    </ul>

    <div class="divider"></div>
    <button id="reportMissingStreetBtn" class="button full" type="button">Report a missing street</button>
    ${state.missingStreets?.length ? renderMissingStreetLog() : ""}
  `;
}

function renderZoneRow(def) {
  const zs = getZoneState(def.id);
  const statusObj = ZONE_STATUSES.find(s => s.id === zs.status) || ZONE_STATUSES[0];
  return `
    <li class="zone-row" data-zone-id="${escapeAttr(def.id)}">
      <div class="zone-row-left">
        <span class="zone-id">${escapeHtml(def.id)}</span>
        <span class="zone-priority-dot ${PRIORITY_CLASS[def.priority] || ""}"></span>
        <span class="zone-street">${escapeHtml(def.street)}</span>
      </div>
      <span class="status-pill ${statusObj.className}">${statusObj.label}</span>
    </li>`;
}

export function renderZoneDetail(id) {
  const def = ZONE_BY_ID[id];
  if (!def) return `<button id="zoneDetailBackBtn" class="button" type="button">Back</button><p class="notice danger">Zone not found.</p>`;

  const zs = getZoneState(id);
  const statusObj = ZONE_STATUSES.find(s => s.id === zs.status) || ZONE_STATUSES[0];
  const isDispatcher = state.profile.dispatcher;

  const statusButtons = ZONE_STATUSES.map(s => `
    <button class="button ${s.id === zs.status ? "active" : ""}" data-set-zone-status="${escapeAttr(s.id)}" type="button">
      ${escapeHtml(s.label)}
    </button>`).join("");

  return `
    <button id="zoneDetailBackBtn" class="button" type="button">Back to zones</button>
    <div class="zone-detail-header">
      <h2>${escapeHtml(def.id)}</h2>
      <span class="status-pill ${statusObj.className}">${statusObj.label}</span>
    </div>

    <dl class="meta-list">
      ${metaRow("Neighbourhood", def.neighborhood)}
      ${metaRow("Street", def.street)}
      ${metaRow("Coverage", def.coverage)}
      ${metaRow("Unit range", def.unitRange)}
      ${metaRow("~Homes", String(def.approxHomes))}
      ${metaRow("Type", def.type)}
      ${metaRow("Priority", def.priority)}
      ${def.notes ? metaRow("Notes", def.notes) : ""}
      ${zs.assignedTeam ? metaRow("Team", zs.assignedTeam) : ""}
      ${zs.captain ? metaRow("Captain", zs.captain) : ""}
      ${zs.updatedAt ? metaRow("Updated", formatTime(zs.updatedAt) + (zs.updatedBy ? ` by ${zs.updatedBy}` : "")) : ""}
    </dl>

    <h3>Status</h3>
    <div class="status-grid">${statusButtons}</div>

    <form id="zoneUpdateForm" class="profile-form" style="margin-top:16px;">
      <label>Houses/units visited
        <input id="zoneUnitsVisited" autocomplete="off" placeholder="e.g. 12, 14, 16 or Units 101-110" value="${escapeAttr(zs.unitsVisited)}" />
      </label>
      ${isDispatcher ? `
        <div class="field-row">
          <label>Assigned team
            <input id="zoneTeam" value="${escapeAttr(zs.assignedTeam)}" />
          </label>
          <label>Captain
            <input id="zoneCaptain" value="${escapeAttr(zs.captain)}" />
          </label>
        </div>` : ""}
      <label>Revisit / notes
        <textarea id="zoneRevisitReason" rows="2" placeholder="Reason for revisit, access issue, concierge info…">${escapeHtml(zs.revisitReason)}</textarea>
      </label>
      <button class="button full" type="submit">Save zone update</button>
    </form>
  `;
}

export function renderMissingStreetForm() {
  const neighborhoodOptions = NEIGHBORHOODS.map(
    n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`,
  ).join("");

  return `
    <button id="missingStreetBackBtn" class="button" type="button">Back to zones</button>
    <h2>Report Missing Street</h2>
    <p class="muted small">Add any street, court, lane, building, or private road not in the zone list. Command centre will assign it a Zone ID.</p>
    <form id="missingStreetForm" class="profile-form">
      <label>Neighbourhood
        <select id="msNeighborhood" required>
          <option value="">— select —</option>
          ${neighborhoodOptions}
        </select>
      </label>
      <label>Street / building / lane name
        <input id="msStreet" required autocomplete="off" placeholder="e.g. Brentwood Crt" />
      </label>
      <label>Nearest intersection
        <input id="msIntersection" autocomplete="off" placeholder="e.g. Near Bathurst & Finch" />
      </label>
      <label>Estimated homes/units
        <input id="msUnits" inputmode="numeric" placeholder="e.g. 30" />
      </label>
      <label>Notes
        <textarea id="msNotes" rows="2" placeholder="Access issues, building type, concierge…"></textarea>
      </label>
      <button class="button full" type="submit">Submit report</button>
    </form>
  `;
}

function renderMissingStreetLog() {
  const list = [...state.missingStreets].reverse().slice(0, 10);
  return `
    <h3>Submitted Missing Streets (${state.missingStreets.length})</h3>
    <ul class="activity-list">
      ${list.map(ms => `
        <li>
          <strong>${escapeHtml(ms.street || "Unknown")}</strong> — ${escapeHtml(ms.neighborhood)}
          <br /><span class="muted small">${escapeHtml(ms.intersection || "")} ${ms.estimatedUnits ? `· ~${escapeHtml(ms.estimatedUnits)} units` : ""}</span>
          <br /><span class="muted small">${formatTime(ms.timestamp)} by ${escapeHtml(ms.submittedBy || "Volunteer")}</span>
        </li>`).join("")}
    </ul>`;
}

// ---- Bind handlers ----

export function bindZonePanel(onSelectZone, onClose) {
  document.getElementById("zoneBackBtn")?.addEventListener("click", onClose);

  document.getElementById("zoneSearchInput")?.addEventListener("input", (e) => {
    store.zoneFilter.query = e.target.value;
    _rerenderZonePanel(onSelectZone, onClose);
  });
  document.getElementById("zoneNeighborFilter")?.addEventListener("change", (e) => {
    store.zoneFilter.neighborhood = e.target.value;
    _rerenderZonePanel(onSelectZone, onClose);
  });
  document.getElementById("zonePriorityFilter")?.addEventListener("change", (e) => {
    store.zoneFilter.priority = e.target.value;
    _rerenderZonePanel(onSelectZone, onClose);
  });
  document.getElementById("zoneStatusFilter")?.addEventListener("change", (e) => {
    store.zoneFilter.status = e.target.value;
    _rerenderZonePanel(onSelectZone, onClose);
  });

  document.querySelectorAll(".zone-row").forEach(row => {
    row.addEventListener("click", () => onSelectZone(row.dataset.zoneId));
  });

  document.getElementById("reportMissingStreetBtn")?.addEventListener("click", () => {
    const panel = document.getElementById("panel");
    panel.innerHTML = renderMissingStreetForm();
    bindMissingStreetForm(onSelectZone, onClose);
  });
}

export function bindZoneDetail(id, onBack) {
  document.getElementById("zoneDetailBackBtn")?.addEventListener("click", onBack);

  document.querySelectorAll("[data-set-zone-status]").forEach(btn => {
    btn.addEventListener("click", () => {
      updateZone(id, { status: btn.dataset.setZoneStatus });
      showToast("Zone status updated.");
    });
  });

  document.getElementById("zoneUpdateForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const updates = {
      unitsVisited: document.getElementById("zoneUnitsVisited")?.value.trim() || "",
      revisitReason: document.getElementById("zoneRevisitReason")?.value.trim() || "",
    };
    if (state.profile.dispatcher) {
      updates.assignedTeam = document.getElementById("zoneTeam")?.value.trim() || "";
      updates.captain = document.getElementById("zoneCaptain")?.value.trim() || "";
    }
    updateZone(id, updates);
    showToast("Zone saved.");
  });
}

function bindMissingStreetForm(onSelectZone, onClose) {
  document.getElementById("missingStreetBackBtn")?.addEventListener("click", () => {
    const panel = document.getElementById("panel");
    panel.innerHTML = renderZonePanel();
    bindZonePanel(onSelectZone, onClose);
  });

  document.getElementById("missingStreetForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    submitMissingStreet({
      neighborhood: document.getElementById("msNeighborhood")?.value || "",
      street: document.getElementById("msStreet")?.value.trim() || "",
      intersection: document.getElementById("msIntersection")?.value.trim() || "",
      estimatedUnits: document.getElementById("msUnits")?.value.trim() || "",
      notes: document.getElementById("msNotes")?.value.trim() || "",
    });
    showToast("Missing street reported. Thank you.");
    const panel = document.getElementById("panel");
    panel.innerHTML = renderZonePanel();
    bindZonePanel(onSelectZone, onClose);
  });
}

function _rerenderZonePanel(onSelectZone, onClose) {
  const panel = document.getElementById("panel");
  panel.innerHTML = renderZonePanel();
  bindZonePanel(onSelectZone, onClose);
}

// ---- helpers ----

function metaRow(label, value) {
  return `<div class="meta-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}
