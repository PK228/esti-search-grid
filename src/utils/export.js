import { SEARCH_AREA, STALE_AFTER_MINUTES } from "../core/constants.js";
import { state, normalizeCells, saveState, defaultMissingPerson } from "../core/state.js";
import { addAudit } from "../core/audit.js";
import { showToast } from "./toast.js";

export function exportState() {
  const payload = {
    exportedAt: new Date().toISOString(),
    area: SEARCH_AREA,
    config: { staleAfterMinutes: STALE_AFTER_MINUTES, phoneVerificationMode: "demo_local_code" },
    cells: state.cells,
    audit: state.audit,
    incidents: state.incidents,
    lastSeen: state.lastSeen,
    lastSeenTrail: state.lastSeenTrail,
    clues: state.clues,
    search: state.search,
    missingPerson: state.missingPerson,
  };
  downloadJson(payload, `esti-search-grid-${new Date().toISOString().slice(0, 10)}.json`);
  addAudit("state_exported", null, {
    cellCount: Object.keys(state.cells).length,
    auditCount: state.audit.length,
  });
  saveState();
  showToast("Search grid exported.");
}

export function exportAudit() {
  const payload = {
    exportedAt: new Date().toISOString(),
    audit: state.audit,
    incidents: state.incidents,
  };
  downloadJson(payload, `esti-search-audit-${new Date().toISOString().slice(0, 10)}.json`);
  addAudit("audit_exported", null, {
    auditCount: state.audit.length,
    incidentCount: state.incidents.length,
  });
  saveState();
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast("Audit exported.");
}

export function downloadJson(payload, fileName) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export async function importStateFromFile(event) {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!imported.cells || typeof imported.cells !== "object") throw new Error("Missing cells");
    state.cells = normalizeCells(imported.cells);
    state.audit = Array.isArray(imported.audit) ? imported.audit : state.audit;
    state.incidents = Array.isArray(imported.incidents) ? imported.incidents : state.incidents;
    state.lastSeen = imported.lastSeen || null;
    state.lastSeenTrail = Array.isArray(imported.lastSeenTrail) ? imported.lastSeenTrail : [];
    state.clues = Array.isArray(imported.clues) ? imported.clues : [];
    state.missingPerson = { ...defaultMissingPerson(), ...(imported.missingPerson || {}) };
    addAudit("state_imported", null, {
      cellCount: Object.keys(state.cells).length,
      auditCount: state.audit.length,
      incidentCount: state.incidents.length,
    });
    saveState();
    document.dispatchEvent(new CustomEvent("esti:import-complete"));
    showToast("Search grid imported.");
  } catch {
    showToast("Could not import that file.");
  } finally {
    event.target.value = "";
  }
}
