import {
  SESSION_KEY,
  SESSION_STARTED_KEY,
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
} from "./constants.js";
import { makeId } from "../utils/format.js";

// Runs immediately on import — must happen before loadState() reads localStorage.
_clearIfRequested();

export const session = _getSession();

function _clearIfRequested() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("reset")) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_STARTED_KEY);
  params.delete("reset");
  const nextSearch = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`,
  );
}

function _getSession() {
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  let startedAt = sessionStorage.getItem(SESSION_STARTED_KEY);
  if (!sessionId) {
    sessionId = makeId("sess");
    startedAt = new Date().toISOString();
    sessionStorage.setItem(SESSION_KEY, sessionId);
    sessionStorage.setItem(SESSION_STARTED_KEY, startedAt);
  }
  return { id: sessionId, startedAt: startedAt || "" };
}
