import { state, saveState } from "../core/state.js";
import { session } from "../core/session.js";
import { addAudit, currentActor, systemActor, actionTypeForStatus } from "../core/audit.js";
import { STATUS, ESCALATION_STATUSES, CLOSED_STATUSES, STALE_AFTER_MINUTES, HEARTBEAT_WARNING_MINUTES } from "../core/constants.js";
import { store } from "../core/store.js";
import { createIncident, resolveIncidentsForGrid } from "./incidents.js";
import { refreshGrid } from "./renderer.js";
import { showToast } from "../utils/toast.js";
import { minutesSince } from "../utils/format.js";

export function updateCell(id, status) {
  const existing = state.cells[id] || {};
  const actorFields = _saveProfileFromCellForm();
  const notes = document.getElementById("cellNotes")?.value.trim() || existing.notes || "";
  const now = new Date().toISOString();
  const previousStatus = existing.status || "open";
  const searchers = getSearchers(existing).map((entry) => ({ ...entry }));
  const myIndex = findSearcherIndex(existing);
  const me = {
    userId: state.profile.userId,
    sessionId: session.id,
    name: actorFields.name,
    contact: actorFields.contact,
    team: actorFields.team,
    phoneVerified: state.profile.phoneVerified,
  };

  let nextStatus = status;
  let toastMessage = `Grid ${id}: ${STATUS[status].label}.`;

  if (status === "searching") {
    if (myIndex === -1) {
      searchers.push({ ...me, joinedAt: now, lastHeartbeatAt: now });
    } else {
      searchers[myIndex] = { ...searchers[myIndex], ...me, lastHeartbeatAt: now };
    }
    nextStatus = "searching";
    toastMessage = `Grid ${id}: you are searching here (${searchers.length} on this grid).`;
    if (searchers.length === 1) {
      window.setTimeout(() => showToast("Buddy advisory: search with a partner. Do not search alone."), 800);
    }
  } else if (status === "done" || status === "stopped") {
    if (myIndex !== -1) searchers.splice(myIndex, 1);
    if (searchers.length > 0) {
      nextStatus = "searching";
      toastMessage = `Grid ${id}: you left. ${searchers.length} still searching here.`;
    } else {
      nextStatus = status;
    }
  } else {
    nextStatus = status;
  }

  const _history = Array.isArray(existing.history) ? [...existing.history] : [];
  if (nextStatus !== previousStatus) {
    _history.push({ status: nextStatus, timestamp: now, byName: actorFields.name || state.profile.name || "Volunteer" });
    if (_history.length > 40) _history.splice(0, _history.length - 40);
  }

  state.cells[id] = {
    ...existing,
    id,
    status: nextStatus,
    searchers,
    name: actorFields.name,
    contact: actorFields.contact,
    team: actorFields.team,
    userId: state.profile.userId,
    sessionId: session.id,
    phoneVerified: state.profile.phoneVerified,
    notes,
    updatedAt: now,
    createdAt: existing.createdAt || now,
    assignedAt: nextStatus === "searching" ? existing.assignedAt || now : existing.assignedAt || "",
    lastHeartbeatAt:
      nextStatus === "searching" ? latestHeartbeatOf(searchers) || now : existing.lastHeartbeatAt || "",
    lastActionBy: currentActor(),
    lastReleaseReason: "",
    history: _history,
  };

  if (nextStatus === "searching" && previousStatus === "stale") {
    state.cells[id].reclaimedAt = now;
  }
  if (ESCALATION_STATUSES.has(nextStatus)) createIncident(id, nextStatus, notes);
  if (CLOSED_STATUSES.has(nextStatus)) resolveIncidentsForGrid(id, `Closed by ${nextStatus}`);

  addAudit(actionTypeForStatus(status), id, {
    status: nextStatus,
    requestedStatus: status,
    previousStatus,
    notes,
    searcherCount: searchers.length,
    phoneVerified: state.profile.phoneVerified,
  });
  saveState();
  refreshGrid();
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast(toastMessage);
}

export function sendHeartbeat(id, { silent = false, source = "manual" } = {}) {
  const cell = state.cells[id];
  if (!cell || cell.status !== "searching") {
    showToast("Heartbeat only applies to an active search grid.");
    return false;
  }
  const myIndex = findSearcherIndex(cell);
  if (myIndex === -1) {
    showToast('Tap "Keep searching" to join this grid first.');
    return false;
  }
  const now = new Date().toISOString();
  const searchers = getSearchers(cell).map((entry) => ({ ...entry }));
  searchers[myIndex] = { ...searchers[myIndex], lastHeartbeatAt: now };
  cell.searchers = searchers;
  cell.lastHeartbeatAt = latestHeartbeatOf(searchers) || now;
  cell.updatedAt = now;
  cell.lastActionBy = currentActor();
  addAudit("heartbeat", id, { searcherCount: searchers.length, auto: source !== "manual", source });
  saveState();
  document.dispatchEvent(new CustomEvent("esti:render"));
  if (!silent) showToast(`Grid ${id} heartbeat recorded.`);
  return true;
}

export function clearCell(id) {
  const cell = state.cells[id];
  const myIndex = cell ? findSearcherIndex(cell) : -1;
  if (!state.profile.dispatcher && myIndex === -1) {
    showToast("Only a dispatcher or a volunteer on this grid can clear it.");
    return;
  }
  const previous = cell ? ownerSnapshot(cell) : null;
  delete state.cells[id];
  addAudit("grid_cleared", id, { previousStatus: cell?.status || "open", previous });
  saveState();
  refreshGrid();
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast(`Grid ${id} cleared — reset to open.`);
}

export function releaseCell(id, reason) {
  const cell = state.cells[id];
  if (!cell) {
    showToast(`Grid ${id} is already open.`);
    return;
  }
  const myIndex = findSearcherIndex(cell);
  if (!state.profile.dispatcher && myIndex === -1) {
    addAudit("release_blocked", id, { releasedSearchers: ownerSnapshot(cell), reason });
    saveState();
    showToast("Only a volunteer searching this grid or dispatcher can release it.");
    return;
  }

  const now = new Date().toISOString();
  const previousStatus = cell.status || "open";

  if (!state.profile.dispatcher && myIndex !== -1) {
    const searchers = getSearchers(cell)
      .map((entry) => ({ ...entry }))
      .filter((_, index) => index !== myIndex);
    if (searchers.length > 0) {
      state.cells[id] = {
        ...cell,
        searchers,
        status: "searching",
        updatedAt: now,
        lastHeartbeatAt: latestHeartbeatOf(searchers),
        lastActionBy: currentActor(),
      };
      addAudit("volunteer_left_grid", id, { previousStatus, searcherCount: searchers.length });
      saveState();
      refreshGrid();
      document.dispatchEvent(new CustomEvent("esti:render"));
      showToast(`Grid ${id}: you left. ${searchers.length} still searching here.`);
      return;
    }
  }

  const _releaseHistory = Array.isArray(cell.history) ? [...cell.history] : [];
  _releaseHistory.push({ status: "stale", timestamp: now, byName: state.profile.name || "Dispatcher" });
  if (_releaseHistory.length > 40) _releaseHistory.splice(0, _releaseHistory.length - 40);

  state.cells[id] = {
    ...cell,
    searchers: [],
    status: "stale",
    updatedAt: now,
    staleReleasedAt: now,
    lastReleaseReason: reason,
    lastActionBy: currentActor(),
    history: _releaseHistory,
  };
  addAudit(reason, id, { previousStatus, releasedSearchers: ownerSnapshot(cell) });
  saveState();
  refreshGrid();
  document.dispatchEvent(new CustomEvent("esti:render"));
  showToast(`Grid ${id} released.`);
}

export function scanStaleCells(options = {}) {
  const now = new Date();
  let released = 0;
  let removedSearchers = 0;

  Object.entries(state.cells).forEach(([id, cell]) => {
    if (cell.status !== "searching") return;
    const searchers = getSearchers(cell);
    const fresh = searchers.filter((entry) => {
      const last = entry.lastHeartbeatAt || entry.joinedAt;
      return last && minutesSince(last, now) < STALE_AFTER_MINUTES;
    });
    if (fresh.length === searchers.length) return;

    removedSearchers += searchers.length - fresh.length;
    const previousStatus = cell.status;

    if (fresh.length > 0) {
      state.cells[id] = {
        ...cell,
        searchers: fresh,
        updatedAt: now.toISOString(),
        lastHeartbeatAt: latestHeartbeatOf(fresh),
        lastActionBy: systemActor(),
      };
      addAudit("stale_searcher_removed", id, { removed: searchers.length - fresh.length, searcherCount: fresh.length }, systemActor());
    } else {
      const _staleHistory = Array.isArray(cell.history) ? [...cell.history] : [];
      _staleHistory.push({ status: "stale", timestamp: now.toISOString(), byName: "Auto-release" });
      if (_staleHistory.length > 40) _staleHistory.splice(0, _staleHistory.length - 40);
      state.cells[id] = {
        ...cell,
        searchers: [],
        status: "stale",
        updatedAt: now.toISOString(),
        staleReleasedAt: now.toISOString(),
        lastReleaseReason: `No heartbeat for ${STALE_AFTER_MINUTES} minutes`,
        lastActionBy: systemActor(),
        history: _staleHistory,
      };
      addAudit("auto_release_stale", id, { previousStatus, releasedSearchers: ownerSnapshot(cell) }, systemActor());
      released += 1;
    }
  });

  if (released || removedSearchers) {
    saveState();
    refreshGrid();
    if (!store.dispatcherLoginOpen) {
      document.dispatchEvent(new CustomEvent("esti:render"));
    }
  }

  if (options.manual) {
    addAudit("stale_release_scan", null, { released, removedSearchers });
    saveState();
    document.dispatchEvent(new CustomEvent("esti:render"));
    showToast(released ? `${released} stale grid released.` : "No stale grids found.");
  } else if (released && !options.silent) {
    showToast(`${released} stale grid released.`);
  }

  return released;
}

export function getSearchers(cell) {
  return Array.isArray(cell?.searchers) ? cell.searchers : [];
}

export function searcherCount(cell) {
  return getSearchers(cell).length;
}

export function findSearcherIndex(cell) {
  return getSearchers(cell).findIndex(
    (entry) =>
      (entry.userId && entry.userId === state.profile.userId) ||
      (entry.sessionId && entry.sessionId === session.id),
  );
}

export function isCurrentUserSearching(cell) {
  return findSearcherIndex(cell) !== -1;
}

export function isOwnedByCurrentUser(cell) {
  return isCurrentUserSearching(cell);
}

export function latestHeartbeatOf(searchers) {
  return (
    searchers
      .map((entry) => entry.lastHeartbeatAt || entry.joinedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || ""
  );
}

export function getStaleEta(cell) {
  const last = cell.lastHeartbeatAt || cell.updatedAt || cell.assignedAt;
  if (!last) return `${STALE_AFTER_MINUTES} minutes without heartbeat`;
  const age = minutesSince(last);
  const remaining = STALE_AFTER_MINUTES - age;
  if (remaining <= 0) return "Due now";
  if (age >= HEARTBEAT_WARNING_MINUTES) return `${remaining} minutes remaining`;
  return `${remaining} minutes`;
}

// ---- Data query helpers used by panel and dispatcher ----

export function getCounts() {
  const counts = { open: store.cellFeatures.length, searching: 0, done: 0, stopped: 0, backup: 0, emergency: 0, found: 0, stale: 0 };
  Object.values(state.cells).forEach((cell) => {
    if (!cell.status || !Object.prototype.hasOwnProperty.call(counts, cell.status)) return;
    counts.open -= 1;
    counts[cell.status] += 1;
  });
  return counts;
}

export function getAnalytics(counts = getCounts()) {
  const covered = counts.done + counts.stopped + counts.found;
  const volunteersSearching = Object.values(state.cells).reduce(
    (total, cell) => total + searcherCount(cell),
    0,
  );
  return {
    coverage: Math.round((covered / Math.max(store.cellFeatures.length, 1)) * 100),
    openIncidents: state.incidents.filter((i) => i.status === "open").length,
    volunteersSearching,
  };
}

export function getCellsByStatus(status) {
  return Object.values(state.cells)
    .filter((cell) => cell.status === status)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function getRecentActivity() {
  return state.audit.filter((event) => event.grid).slice(-8).reverse();
}

export function ownerSnapshot(cell) {
  const searchers = getSearchers(cell);
  return {
    searcherCount: searchers.length,
    searchers: searchers.map((entry) => ({
      userId: entry.userId || "",
      name: entry.name || "",
      phone: entry.contact ? `***-***-${String(entry.contact).replace(/\D/g, "").slice(-4)}` : "",
      team: entry.team || "",
      phoneVerified: Boolean(entry.phoneVerified),
    })),
  };
}

function _saveProfileFromCellForm() {
  const previousContact = state.profile.contact;
  const name = document.getElementById("cellName")?.value.trim() || state.profile.name;
  const contact = document.getElementById("cellContact")?.value.trim() || state.profile.contact;
  const team = document.getElementById("cellTeam")?.value.trim() || state.profile.team;

  state.profile.name = name;
  state.profile.contact = contact;
  state.profile.team = team;
  state.profile.lastSeenAt = new Date().toISOString();

  if (previousContact !== contact) {
    state.profile.phoneVerified = false;
    state.profile.verifiedAt = "";
    state.profile.verificationCode = "";
    state.profile.verificationSentAt = "";
  }
  return { name, contact, team };
}
