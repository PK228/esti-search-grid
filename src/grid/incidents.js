import { state, saveState } from "../core/state.js";
import { addAudit, currentActor } from "../core/audit.js";
import { STATUS } from "../core/constants.js";
import { makeId } from "../utils/format.js";
import { showToast } from "../utils/toast.js";

export function createIncident(grid, status, notes) {
  const existing = getOpenIncidentForGrid(grid);
  const now = new Date().toISOString();
  const incident = {
    id: existing?.id || makeId("inc"),
    grid,
    type: STATUS[status]?.label || status,
    status: "open",
    severity: status === "backup" ? "moderate" : "critical",
    route: routeForStatus(status),
    notes,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || currentActor(),
    updatedBy: currentActor(),
  };

  if (existing) {
    Object.assign(existing, incident);
    addAudit("incident_updated", grid, {
      incidentId: incident.id,
      type: incident.type,
      route: incident.route,
    });
  } else {
    state.incidents.push(incident);
    addAudit("incident_created", grid, {
      incidentId: incident.id,
      type: incident.type,
      route: incident.route,
    });
  }
}

export function resolveIncidentForGrid(grid) {
  const incident = getOpenIncidentForGrid(grid);
  if (!incident) {
    showToast("No open incident for this grid.");
    return;
  }
  incident.status = "resolved";
  incident.resolvedAt = new Date().toISOString();
  incident.resolvedBy = currentActor();
  addAudit("incident_resolved", grid, { incidentId: incident.id });
  saveState();
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast(`Incident for ${grid} resolved.`);
}

export function resolveIncidentsForGrid(grid, reason) {
  getOpenIncidents()
    .filter((incident) => incident.grid === grid)
    .forEach((incident) => {
      incident.status = "resolved";
      incident.resolvedAt = new Date().toISOString();
      incident.resolvedBy = currentActor();
      incident.resolutionReason = reason;
      addAudit("incident_auto_resolved", grid, { incidentId: incident.id, reason });
    });
}

export function getOpenIncidentForGrid(grid) {
  return state.incidents.find(
    (incident) => incident.grid === grid && incident.status === "open",
  );
}

export function getOpenIncidents() {
  return state.incidents.filter((incident) => incident.status === "open");
}

export function routeForStatus(status) {
  if (status === "backup") return "Dispatcher review, assign nearby team.";
  if (status === "found") return "Hold location, notify command lead and emergency services.";
  return "Immediate dispatcher escalation, call emergency services if there is danger.";
}
