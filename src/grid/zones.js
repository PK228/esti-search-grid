import { state, defaultZoneRecord, saveState } from "../core/state.js";
import { ZONE_DEFINITIONS, ZONE_BY_ID, NEIGHBORHOODS, TOTAL_HOMES } from "../data/zones.js";

export { ZONE_DEFINITIONS, ZONE_BY_ID, NEIGHBORHOODS, TOTAL_HOMES };

export const ZONE_STATUSES = [
  { id: "UNASSIGNED",        label: "Unassigned",        className: "status-open" },
  { id: "IN_PROGRESS",       label: "In Progress",       className: "status-searching" },
  { id: "COMPLETED",         label: "Completed",         className: "status-done" },
  { id: "REVISIT_REQUIRED",  label: "Revisit Required",  className: "status-backup" },
];

export function getZoneState(id) {
  return state.zones[id] ? { ...defaultZoneRecord(), ...state.zones[id] } : defaultZoneRecord();
}

export function updateZone(id, updates) {
  const current = getZoneState(id);
  state.zones[id] = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
    updatedBy: state.profile.name || state.profile.userId,
  };
  saveState();
  document.dispatchEvent(new CustomEvent("esti:render"));
}

export function getZoneStats() {
  const counts = { UNASSIGNED: 0, IN_PROGRESS: 0, COMPLETED: 0, REVISIT_REQUIRED: 0 };
  for (const def of ZONE_DEFINITIONS) {
    const s = getZoneState(def.id).status;
    counts[s] = (counts[s] || 0) + 1;
  }
  const total = ZONE_DEFINITIONS.length;
  const completedHomes = ZONE_DEFINITIONS
    .filter(d => getZoneState(d.id).status === "COMPLETED")
    .reduce((sum, d) => sum + d.approxHomes, 0);
  return { ...counts, total, totalHomes: TOTAL_HOMES, completedHomes };
}

export function getZonesByNeighborhood(neighborhood) {
  return ZONE_DEFINITIONS.filter(d => d.neighborhood === neighborhood);
}

export function filterZones({ neighborhood, priority, status, query }) {
  const q = (query || "").toLowerCase().trim();
  return ZONE_DEFINITIONS.filter(def => {
    if (neighborhood && def.neighborhood !== neighborhood) return false;
    if (priority && def.priority !== priority) return false;
    if (status) {
      const zs = getZoneState(def.id).status;
      if (zs !== status) return false;
    }
    if (q && !def.street.toLowerCase().includes(q) && !def.id.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function submitMissingStreet(data) {
  if (!Array.isArray(state.missingStreets)) state.missingStreets = [];
  state.missingStreets.push({
    id: `ms-${Date.now()}`,
    timestamp: new Date().toISOString(),
    submittedBy: state.profile.name || state.profile.userId,
    neighborhood: data.neighborhood || "",
    street: data.street || "",
    intersection: data.intersection || "",
    estimatedUnits: data.estimatedUnits || "",
    notes: data.notes || "",
    status: "PENDING",
  });
  saveState();
  document.dispatchEvent(new CustomEvent("esti:render"));
}
