import { state } from "./state.js";
import { session } from "./session.js";
import { maskPhone, makeId } from "../utils/format.js";

export function addAudit(actionType, grid, details, actor = currentActor()) {
  const event = {
    id: makeId("evt"),
    timestamp: new Date().toISOString(),
    user: actor,
    grid,
    actionType,
    details: details || {},
  };
  state.audit.push(event);
  if (state.audit.length > 1000) {
    state.audit = state.audit.slice(-1000);
  }
  return event;
}

export function currentActor() {
  return {
    userId: state.profile.userId || "unknown",
    sessionId: session.id,
    name: state.profile.name || "",
    phone: maskPhone(state.profile.contact),
    team: state.profile.team || "",
    role: state.profile.role || "volunteer",
    phoneVerified: Boolean(state.profile.phoneVerified),
  };
}

export function systemActor() {
  return {
    userId: "system",
    sessionId: "system",
    name: "System",
    phone: "",
    team: "",
    role: "system",
    phoneVerified: false,
  };
}

export function actionTypeForStatus(status) {
  return (
    {
      searching: "claim_or_continue_search",
      done: "search_completed",
      stopped: "search_stopped",
      backup: "backup_requested",
      emergency: "emergency_reported",
      found: "found_reported",
    }[status] || "status_updated"
  );
}

export function getGridAuditCount(id) {
  return state.audit.filter((event) => event.grid === id).length;
}
