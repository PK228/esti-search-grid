import { state, saveState } from "../core/state.js";
import { addAudit } from "../core/audit.js";
import { makeId } from "../utils/format.js";

export const CLUE_TYPES = [
  { id: "clothing",  label: "Clothing" },
  { id: "footprint", label: "Footprint" },
  { id: "object",    label: "Object" },
  { id: "scent",     label: "Scent / K9" },
  { id: "witness",   label: "Witness sighting" },
  { id: "vehicle",   label: "Vehicle" },
  { id: "other",     label: "Other" },
];

export function getCluesForGrid(gridId) {
  return (state.clues || []).filter((c) => c.gridId === gridId);
}

export function getOpenClues() {
  return (state.clues || []).filter((c) => !c.resolved);
}

export function logClue({ gridId, type, description, lat, lng, photoData }) {
  if (!Array.isArray(state.clues)) state.clues = [];
  const clue = {
    id: makeId("clue"),
    gridId: gridId || null,
    type: type || "other",
    description: (description || "").slice(0, 400),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    photoData: photoData || "",
    loggedBy: { name: state.profile.name || "Volunteer", userId: state.profile.userId },
    loggedAt: new Date().toISOString(),
    resolved: false,
  };
  state.clues.push(clue);
  addAudit("clue_logged", gridId, { type, id: clue.id });
  saveState();
  document.dispatchEvent(new CustomEvent("esti:render"));
  document.dispatchEvent(new CustomEvent("esti:render-clues"));
  return clue;
}

export function resolveClue(clueId) {
  const clue = (state.clues || []).find((c) => c.id === clueId);
  if (!clue || clue.resolved) return;
  clue.resolved = true;
  clue.resolvedBy = state.profile.name || "Dispatcher";
  clue.resolvedAt = new Date().toISOString();
  addAudit("clue_resolved", clue.gridId, { type: clue.type, id: clueId });
  saveState();
  document.dispatchEvent(new CustomEvent("esti:render"));
  document.dispatchEvent(new CustomEvent("esti:render-clues"));
}
