import { STORAGE_KEY, LEGACY_STORAGE_KEY, SEARCH_ID, SEARCH_AREA, GRID_CELL_KM } from "./constants.js";
import { session } from "./session.js"; // ensures clearIfRequested ran first
import { makeId } from "../utils/format.js";

export const state = loadState();

export function defaultProfile() {
  return {
    userId: "",
    name: "",
    contact: "",
    team: "",
    role: "volunteer",
    dispatcher: false,
    phoneVerified: false,
    verificationCode: "",
    verificationSentAt: "",
    verifiedAt: "",
    createdAt: "",
    lastSeenAt: "",
  };
}

function defaultSearch() {
  return {
    id: SEARCH_ID || null,
    orgName: "",
    orgCity: "",
    boundary: SEARCH_AREA.boundary,
    gridCellKm: GRID_CELL_KM,
    active: true,
  };
}

export function defaultMissingPerson() {
  return {
    name: "",
    age: "",
    gender: "",
    category: "",   // dementia | autism | intellectual | despondent | child | other
    description: "",
    clothing: "",
    medicalNotes: "",
    photoData: "",      // base64 JPEG thumbnail, compressed client-side
  };
}

export function normalizeCells(cells) {
  if (!cells || typeof cells !== "object") return {};
  Object.values(cells).forEach((cell) => {
    if (!cell || typeof cell !== "object") return;
    if (!Array.isArray(cell.searchers)) {
      if (cell.status === "searching" && cell.userId) {
        cell.searchers = [
          {
            userId: cell.userId,
            sessionId: cell.sessionId || "",
            name: cell.name || "",
            contact: cell.contact || "",
            team: cell.team || "",
            phoneVerified: Boolean(cell.phoneVerified),
            joinedAt: cell.assignedAt || cell.updatedAt || cell.createdAt || "",
            lastHeartbeatAt: cell.lastHeartbeatAt || cell.updatedAt || "",
          },
        ];
      } else {
        cell.searchers = [];
      }
    }
  });
  return cells;
}

// zone status record — keyed by zone ID (e.g. "BM-001-1")
export function defaultZoneRecord() {
  return {
    status: "UNASSIGNED", // UNASSIGNED | IN_PROGRESS | COMPLETED | REVISIT_REQUIRED
    assignedTeam: "",
    captain: "",
    unitsVisited: "",
    revisitReason: "",
    updatedAt: "",
    updatedBy: "",
  };
}

function loadState() {
  const fallback = {
    cells: {},
    zones: {},
    missingStreets: [],
    profile: defaultProfile(),
    audit: [],
    incidents: [],
    lastSeen: null,
    lastSeenTrail: [],
    clues: [],
    search: defaultSearch(),
    missingPerson: defaultMissingPerson(),
  };
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    return {
      cells: normalizeCells(saved.cells || {}),
      zones: saved.zones && typeof saved.zones === "object" ? saved.zones : {},
      missingStreets: Array.isArray(saved.missingStreets) ? saved.missingStreets : [],
      profile: { ...defaultProfile(), ...(saved.profile || {}) },
      audit: Array.isArray(saved.audit) ? saved.audit : [],
      incidents: Array.isArray(saved.incidents) ? saved.incidents : [],
      lastSeen: saved.lastSeen || null,
      lastSeenTrail: Array.isArray(saved.lastSeenTrail) ? saved.lastSeenTrail : [],
      clues: Array.isArray(saved.clues) ? saved.clues : [],
      search: { ...defaultSearch(), ...(saved.search || {}) },
      missingPerson: { ...defaultMissingPerson(), ...(saved.missingPerson || {}) },
    };
  } catch {
    return fallback;
  }
}

function _statePayload() {
  return {
    version: 2,
    cells: state.cells,
    zones: state.zones,
    missingStreets: state.missingStreets,
    profile: state.profile,
    audit: state.audit,
    incidents: state.incidents,
    lastSeen: state.lastSeen,
    lastSeenTrail: state.lastSeenTrail,
    clues: state.clues,
    search: state.search,
    missingPerson: state.missingPerson,
    savedAt: new Date().toISOString(),
  };
}

export function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_statePayload()));
  document.dispatchEvent(new CustomEvent("esti:save-state"));
}

export function saveLocalOnly() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_statePayload()));
}

export function sharedPayload() {
  return {
    cells: state.cells,
    zones: state.zones,
    missingStreets: state.missingStreets,
    audit: state.audit,
    incidents: state.incidents,
    lastSeen: state.lastSeen || null,
    lastSeenTrail: state.lastSeenTrail || [],
    clues: state.clues || [],
    missingPerson: state.missingPerson,
    ...(state.search?.id ? { searchId: state.search.id } : {}),
  };
}

export function ensureIdentity() {
  const now = new Date().toISOString();
  if (!state.profile.userId) {
    state.profile.userId = makeId("vol");
    state.profile.createdAt = now;
  }
  state.profile.lastSeenAt = now;
  state.profile.sessionId = session.id;
  state.profile.sessionStartedAt = session.startedAt;
  saveState();
}
