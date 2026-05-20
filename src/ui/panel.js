import { STATUS, KOESTER_CATEGORIES } from "../core/constants.js";
import { state, saveState, defaultMissingPerson } from "../core/state.js";
import { session } from "../core/session.js";
import { store } from "../core/store.js";
import { addAudit } from "../core/audit.js";
import {
  getCounts, getAnalytics, getCellsByStatus, getRecentActivity,
  getStaleEta, getSearchers, isOwnedByCurrentUser,
  updateCell, sendHeartbeat, releaseCell, clearCell, scanStaleCells,
} from "../grid/cells.js";
import { getOpenIncidentForGrid, resolveIncidentForGrid } from "../grid/incidents.js";
import { renderDispatcherDashboard, renderDispatcherLogin, bindDispatcherLogin, loadVolunteerQueue, bindVolunteerQueueActions } from "./dispatcher.js";
import { renderZonePanel, renderZoneDetail, bindZonePanel, bindZoneDetail } from "./zone-panel.js";
import { exportState, exportAudit } from "../utils/export.js";
import { togglePlaceLastSeen, removeLastSeen, clearLastSeenTrail, geocodeLastSeen, saveLastSeenDetails, handleLastSeenPhoto, renderClueMarkers } from "./map.js";
import { CLUE_TYPES, getCluesForGrid, getOpenClues, logClue, resolveClue } from "../grid/clues.js";
import { savePositionsKey } from "../core/positions.js";
import { escapeHtml, escapeAttr, formatTime, formatRelativeAge, shortId, maskPhone, humanAction } from "../utils/format.js";
import { showToast } from "../utils/toast.js";

export { getCellsByStatus }; // re-export so dispatcher.js stays clean

export function renderPanel() {
  const panel = document.getElementById("panel");
  if (store.dispatcherLoginOpen && !state.profile.dispatcher) {
    panel.innerHTML = renderDispatcherLogin();
    bindDispatcherLogin();
    return;
  }
  if (store.zonePanelOpen) {
    try {
      if (store.activeZoneId) {
        panel.innerHTML = renderZoneDetail(store.activeZoneId);
        bindZoneDetail(store.activeZoneId, _openZoneList);
      } else {
        panel.innerHTML = renderZonePanel();
        bindZonePanel(_openZoneDetail, _closeZonePanel);
      }
    } catch (err) {
      panel.innerHTML = `<p class="notice danger"><strong>Zone panel error:</strong> ${escapeHtml(String(err))}</p><button id="zoneErrBack" class="button" type="button">Back</button>`;
      document.getElementById("zoneErrBack")?.addEventListener("click", _closeZonePanel);
      console.error("Zone panel error:", err);
    }
    return;
  }
  if (!store.activeCellId) {
    panel.innerHTML = renderCommandPanel();
    bindCommandPanel();
    if (state.profile.dispatcher) {
      bindVolunteerQueueActions();
      loadVolunteerQueue();
    }
    return;
  }
  panel.innerHTML = renderCellPanel(store.activeCellId);
  bindCellPanel(store.activeCellId);
}

function _openZoneDetail(id) {
  store.activeZoneId = id;
  renderPanel();
}

function _openZoneList() {
  store.activeZoneId = null;
  renderPanel();
}

function _closeZonePanel() {
  store.zonePanelOpen = false;
  store.activeZoneId = null;
  renderPanel();
  document.dispatchEvent(new CustomEvent("esti:mode-buttons-changed"));
}

function renderCommandPanel() {
  const counts = getCounts();
  const analytics = getAnalytics(counts);
  const activity = getRecentActivity();
  return `
    <h2>Command Board</h2>
    <p class="muted tight">${store.cellFeatures.length} grid squares, 0.5 km each. Grid updates sync across phones; each volunteer identity stays on their own device.</p>
    <p class="sync-line ${store.sharedSyncStatus === "live" ? "live" : "offline"}">Shared sync: ${escapeHtml(store.sharedSyncStatus)}</p>
    <div class="summary-grid">
      ${summaryItem(counts.open, "Open")}
      ${summaryItem(counts.searching, "Searching")}
      ${summaryItem(counts.done, "Complete")}
      ${summaryItem(counts.backup + counts.emergency + counts.found, "Escalations")}
    </div>
    <div class="metric-grid">
      ${metricItem(`${analytics.coverage}%`, "Coverage")}
      ${metricItem(String(counts.stale), "Stale released")}
      ${metricItem(String(analytics.openIncidents), "Open incidents")}
      ${metricItem(String(analytics.volunteersSearching), "Volunteers out")}
    </div>

    ${renderMissingPersonSection()}
    ${renderWhatsAppShare()}

    <h3>Volunteer Identity</h3>
    <form id="profileForm" class="profile-form">
      <label>Name
        <input id="profileName" autocomplete="name" value="${escapeAttr(state.profile.name)}" />
      </label>
      <div class="field-row">
        <label>Phone
          <input id="profileContact" autocomplete="tel" value="${escapeAttr(state.profile.contact)}" />
        </label>
        <label>Team
          <input id="profileTeam" value="${escapeAttr(state.profile.team)}" />
        </label>
      </div>
      <div class="button-row">
        <button class="button full" type="submit">Save identity</button>
      </div>
    </form>

    <div class="identity-card">
      <span class="role-pill ${state.profile.phoneVerified ? "verified" : ""}">
        ${state.profile.phoneVerified ? "Phone verified" : "Phone unverified"}
      </span>
      <span class="role-pill">${escapeHtml(state.profile.role)}</span>
      <span class="small">Session ${shortId(session.id)}</span>
    </div>

    <div class="verification-row">
      <button id="sendCodeBtn" class="button" type="button">Send demo code</button>
      <label>Code
        <input id="phoneCode" inputmode="numeric" autocomplete="one-time-code" />
      </label>
      <button id="verifyCodeBtn" class="button success" type="button">Verify</button>
    </div>
    ${
      state.profile.verificationCode
        ? `<p class="notice warning">Demo code: <strong>${escapeHtml(state.profile.verificationCode)}</strong>. Real SMS verification needs a backend.</p>`
        : ""
    }

    ${state.profile.dispatcher ? renderDispatcherDashboard() : ""}

    <div class="divider"></div>
    <h3>Recent Updates</h3>
    ${renderActivity(activity)}
  `;
}

function renderCellPanel(id) {
  const entry = state.cells[id] || {};
  const statusKey = entry.status || "open";
  const status = STATUS[statusKey] || STATUS.open;
  const activeIncident = getOpenIncidentForGrid(id);
  const searchers = getSearchers(entry);
  const heartbeatAge = entry.lastHeartbeatAt ? formatRelativeAge(entry.lastHeartbeatAt) : "None";
  const staleEta = entry.status === "searching" ? getStaleEta(entry) : "";

  return `
    <button id="backBtn" class="button" type="button">Back</button>
    <h2 style="margin-top: 16px;">Grid ${id}</h2>
    <span class="status-pill ${status.className}">${status.label}</span>
    ${activeIncident ? `<p class="notice danger"><strong>${escapeHtml(activeIncident.type)}</strong>: ${escapeHtml(activeIncident.route)}</p>` : ""}

    ${renderSearcherList(searchers)}

    <dl class="meta-list">
      ${metaRow("People searching", String(searchers.length))}
      ${metaRow("Updated", entry.updatedAt ? formatTime(entry.updatedAt) : "Never")}
      ${metaRow("Last heartbeat", heartbeatAge)}
      ${staleEta ? metaRow("Auto-release", staleEta) : ""}
      ${_autoHeartbeatNote(id, entry) ? metaRow("Auto-heartbeat", _autoHeartbeatNote(id, entry)) : ""}
    </dl>

    <form id="cellForm" class="cell-form">
      <label>Your name
        <input id="cellName" autocomplete="name" value="${escapeAttr(state.profile.name)}" />
      </label>
      <div class="field-row">
        <label>Your phone
          <input id="cellContact" autocomplete="tel" value="${escapeAttr(state.profile.contact)}" />
        </label>
        <label>Your team
          <input id="cellTeam" value="${escapeAttr(state.profile.team)}" />
        </label>
      </div>
      <label>Notes
        <textarea id="cellNotes">${escapeHtml(entry.notes ?? "")}</textarea>
      </label>
    </form>

    ${renderCellClues(id)}

    <h3>Status</h3>
    <div class="status-grid">
      <button class="button primary" data-status="searching" type="button">Currently searching</button>
      <button class="button success" data-status="done" type="button">Search complete</button>
      <button class="button" data-status="stopped" type="button">Stopped</button>
      <button class="button warning" data-status="backup" type="button">Need backup</button>
      <button class="button danger" data-status="emergency" type="button">Emergency</button>
      <button class="button found" data-status="found" type="button">Found subject</button>
    </div>
    <div class="button-row stack-space">
      <button id="heartbeatBtn" class="button full" type="button">Send heartbeat</button>
      ${
        state.profile.dispatcher || isOwnedByCurrentUser(entry)
          ? '<button id="releaseCellBtn" class="button warning full" type="button">Release grid</button>'
          : ""
      }
      ${
        state.profile.dispatcher || isOwnedByCurrentUser(entry)
          ? '<button id="clearCellBtn" class="button full" type="button">Clear grid (undo)</button>'
          : ""
      }
      ${
        state.profile.dispatcher && activeIncident
          ? '<button id="resolveIncidentBtn" class="button success full" type="button">Resolve incident</button>'
          : ""
      }
    </div>
  `;
}

function bindCommandPanel() {
  document.getElementById("missingPersonForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    _saveMissingPerson();
  });
  document.getElementById("mpPhotoInput")?.addEventListener("change", _handleMissingPersonPhoto);
  document.getElementById("profileForm").addEventListener("submit", (e) => {
    e.preventDefault();
    _saveProfileFromCommand();
  });
  document.getElementById("sendCodeBtn").addEventListener("click", _sendVerificationCode);
  document.getElementById("verifyCodeBtn").addEventListener("click", _verifyPhoneCode);

  document.getElementById("runStaleBtn")?.addEventListener("click", () => scanStaleCells({ manual: true }));
  document.getElementById("exportAuditBtn")?.addEventListener("click", exportAudit);
  document.getElementById("positionsKeyBtn")?.addEventListener("click", async () => {
    await savePositionsKey();
    loadVolunteerQueue();
  });
  document.getElementById("placeLastSeenBtn")?.addEventListener("click", togglePlaceLastSeen);
  document.getElementById("removeLastSeenBtn")?.addEventListener("click", removeLastSeen);
  document.getElementById("clearTrailBtn")?.addEventListener("click", clearLastSeenTrail);
  document.getElementById("lastSeenForm")?.addEventListener("submit", saveLastSeenDetails);
  document.getElementById("lastSeenPhotoInput")?.addEventListener("change", handleLastSeenPhoto);
  document.getElementById("lastSeenAddressForm")?.addEventListener("submit", geocodeLastSeen);

  document.querySelectorAll("[data-jump-grid]").forEach((button) => {
    button.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("esti:select-cell", { detail: button.dataset.jumpGrid }));
    });
  });
}

function bindCellPanel(id) {
  document.getElementById("backBtn").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("esti:deselect-cell"));
  });
  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", () => updateCell(id, button.dataset.status));
  });
  document.getElementById("heartbeatBtn").addEventListener("click", () => sendHeartbeat(id));
  document.getElementById("releaseCellBtn")?.addEventListener("click", () => releaseCell(id, "manual_release"));
  document.getElementById("clearCellBtn")?.addEventListener("click", () => clearCell(id));
  document.getElementById("resolveIncidentBtn")?.addEventListener("click", () => resolveIncidentForGrid(id));

  // Clue form
  let _cluePhotoData = "";
  document.getElementById("cluePhotoInput")?.addEventListener("change", async (e) => {
    const [file] = e.target.files;
    if (!file) return;
    try {
      _cluePhotoData = await _compressPhoto(file, 360, 0.72);
      document.getElementById("cluePhotoStatus").textContent = "Photo ready.";
    } catch { document.getElementById("cluePhotoStatus").textContent = "Photo failed."; }
  });
  document.getElementById("clueForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const type = document.getElementById("clueType")?.value || "other";
    const description = document.getElementById("clueDescription")?.value.trim() || "";
    const latlng = store.lastGpsFix;
    logClue({ gridId: id, type, description, lat: latlng?.lat, lng: latlng?.lng, photoData: _cluePhotoData });
    _cluePhotoData = "";
    showToast("Clue logged.");
  });
  document.querySelectorAll("[data-resolve-clue]").forEach((btn) => {
    btn.addEventListener("click", () => resolveClue(btn.dataset.resolveClue));
  });
}

// ---- Helpers ----

function summaryItem(count, label) {
  return `<div class="summary-item"><strong>${count}</strong><span>${label}</span></div>`;
}

function metricItem(value, label) {
  return `<div class="metric-item"><strong>${escapeHtml(String(value))}</strong><span>${label}</span></div>`;
}

function renderActivity(activity) {
  if (!activity.length) return '<p class="muted">No grid updates yet.</p>';
  return `
    <ul class="activity-list">
      ${activity.map((event) => `
        <li>
          <strong>${escapeHtml(event.grid)}</strong>
          ${escapeHtml(humanAction(event.actionType))}
          ${event.user?.name ? `by ${escapeHtml(event.user.name)}` : ""}
          <br />${formatTime(event.timestamp)}
        </li>`).join("")}
    </ul>`;
}

function renderSearcherList(searchers) {
  if (!searchers.length) return '<p class="notice">No volunteers on this grid yet. Tap "Keep searching" below to start.</p>';
  const noun = searchers.length === 1 ? "person" : "people";
  return `
    <div class="searcher-block">
      <p class="searcher-count">${searchers.length} ${noun} searching here</p>
      <ul class="searcher-list">
        ${searchers.map((entry) => {
          const isMe =
            (entry.userId && entry.userId === state.profile.userId) ||
            (entry.sessionId && entry.sessionId === session.id);
          return `<li>
            <strong>${escapeHtml(entry.name || "Volunteer")}</strong>${isMe ? ' <span class="you-pill">you</span>' : ""}
            ${entry.team ? `<span class="small">${escapeHtml(entry.team)}</span>` : ""}
          </li>`;
        }).join("")}
      </ul>
    </div>`;
}

function _autoHeartbeatNote(id, entry) {
  if (!store.gpsWatchId) return "";
  if (!isOwnedByCurrentUser(entry) || entry.status !== "searching") return "";
  if (store.gpsCellId !== id) return "Outside your grid — auto-heartbeat paused";
  const s = store.autoHeartbeatStatus;
  if (s === "poor_accuracy") return "GPS too weak for auto-heartbeat";
  if (s === "active") {
    const lastAt = store.lastAutoHeartbeatAtByCell[id];
    if (!lastAt) return "Auto-heartbeat active";
    const mins = Math.round((Date.now() - lastAt) / 60000);
    return mins < 1 ? "Active — recorded just now" : `Active — recorded ${mins} min ago`;
  }
  return "";
}

function metaRow(label, value) {
  return `<div class="meta-row"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

// ---- Clues ----

function renderCellClues(gridId) {
  const clues = getCluesForGrid(gridId);
  const typeOptions = CLUE_TYPES.map(
    ({ id, label }) => `<option value="${escapeAttr(id)}">${escapeHtml(label)}</option>`,
  ).join("");
  const clueList = clues.length
    ? `<ul class="clue-list">
        ${clues.map((c) => `
          <li class="clue-item${c.resolved ? " resolved" : ""}">
            <span class="clue-type">${escapeHtml(c.type)}</span>
            ${c.description ? `<span>${escapeHtml(c.description)}</span>` : ""}
            <small>${escapeHtml(c.loggedBy?.name || "Volunteer")}</small>
            ${!c.resolved && state.profile.dispatcher
              ? `<button class="link-button" type="button" data-resolve-clue="${escapeAttr(c.id)}">Resolve</button>`
              : ""}
          </li>`).join("")}
      </ul>`
    : '<p class="muted small">No clues logged for this grid yet.</p>';

  return `
    <div class="divider"></div>
    <h3>Clues (${clues.filter((c) => !c.resolved).length} open)</h3>
    ${clueList}
    <form id="clueForm" class="profile-form">
      <div class="field-row">
        <label>Type
          <select id="clueType">${typeOptions}</select>
        </label>
      </div>
      <label>Description
        <input id="clueDescription" autocomplete="off" placeholder="What was found and where exactly…" />
      </label>
      <div class="photo-upload-row">
        <label class="button full" style="cursor:pointer;text-align:center;">
          Add photo
          <input id="cluePhotoInput" type="file" accept="image/*" hidden />
        </label>
        <span id="cluePhotoStatus" class="muted small"></span>
      </div>
      <button class="button warning full" type="submit">Log clue</button>
    </form>
  `;
}

// ---- Missing Person ----

function renderMissingPersonSection() {
  const mp = state.missingPerson || defaultMissingPerson();
  const isDispatcher = state.profile.dispatcher;

  if (!isDispatcher) {
    if (!mp.name) return "";
    const catLabel = mp.category ? KOESTER_CATEGORIES.find((c) => c.id === mp.category)?.label || mp.category : null;
    const photoThumb = mp.photoData ? `<img src="${mp.photoData}" class="photo-thumb" alt="Missing person photo" />` : "";
    return `
      <div class="divider"></div>
      <h3>Missing Person</h3>
      <div class="mp-readonly">
        ${photoThumb}
        ${mp.name ? `<p class="mp-name">${escapeHtml(mp.name)}${mp.age ? `, age ${escapeHtml(mp.age)}` : ""}${mp.gender ? ` (${escapeHtml(mp.gender)})` : ""}</p>` : ""}
        ${catLabel ? `<p class="mp-detail"><span class="mp-key">Category</span> ${escapeHtml(catLabel)}</p>` : ""}
        ${mp.clothing ? `<p class="mp-detail"><span class="mp-key">Clothing</span> ${escapeHtml(mp.clothing)}</p>` : ""}
        ${mp.description ? `<p class="mp-detail"><span class="mp-key">Description</span> ${escapeHtml(mp.description)}</p>` : ""}
        ${mp.medicalNotes ? `<p class="mp-detail"><span class="mp-key">Medical</span> ${escapeHtml(mp.medicalNotes)}</p>` : ""}
      </div>
    `;
  }

  const categoryOptions = KOESTER_CATEGORIES.map(
    ({ id, label }) =>
      `<option value="${escapeAttr(id)}" ${mp.category === id ? "selected" : ""}>${escapeHtml(label)}</option>`,
  ).join("");
  const photoThumb = mp.photoData
    ? `<img src="${mp.photoData}" class="photo-thumb" alt="Missing person photo" />`
    : "";

  return `
    <div class="divider"></div>
    <h3>Missing Person</h3>
    <form id="missingPersonForm" class="profile-form">
      <div class="photo-upload-row">
        ${photoThumb}
        <label class="button full" style="cursor:pointer;text-align:center;">
          ${mp.photoData ? "Replace photo" : "Upload photo"}
          <input id="mpPhotoInput" type="file" accept="image/*" hidden />
        </label>
      </div>
      <label>Full name
        <input id="mpName" autocomplete="off" value="${escapeAttr(mp.name)}" placeholder="Name" />
      </label>
      <div class="field-row">
        <label>Age
          <input id="mpAge" inputmode="numeric" value="${escapeAttr(mp.age)}" placeholder="e.g. 72" />
        </label>
        <label>Gender
          <input id="mpGender" value="${escapeAttr(mp.gender)}" placeholder="e.g. Male" />
        </label>
      </div>
      <label>Category
        <select id="mpCategory">
          <option value="">— select —</option>
          ${categoryOptions}
        </select>
      </label>
      <label>Physical description
        <textarea id="mpDescription" rows="2" placeholder="Height, build, distinguishing features…">${escapeHtml(mp.description)}</textarea>
      </label>
      <label>Clothing
        <textarea id="mpClothing" rows="2" placeholder="What they were wearing when last seen…">${escapeHtml(mp.clothing)}</textarea>
      </label>
      <label>Medical / behavioural notes
        <textarea id="mpMedical" rows="2" placeholder="Conditions, medications, typical behaviours…">${escapeHtml(mp.medicalNotes)}</textarea>
      </label>
      <div class="button-row">
        <button class="button full" type="submit">Save profile</button>
      </div>
    </form>
    ${mp.category ? `<p class="notice success small">Koester rings shown on map (${KOESTER_CATEGORIES.find((c) => c.id === mp.category)?.label || mp.category}).</p>` : ""}
  `;
}

function renderWhatsAppShare() {
  const mp = state.missingPerson || defaultMissingPerson();
  if (!mp.name) return "";
  const url = window.location.href;
  const lines = [
    `🔍 *SEARCH ACTIVE — ESTI*`,
    mp.name ? `*Missing:* ${mp.name}${mp.age ? `, age ${mp.age}` : ""}${mp.gender ? ` (${mp.gender})` : ""}` : null,
    mp.clothing ? `*Clothing:* ${mp.clothing}` : null,
    mp.description ? `*Description:* ${mp.description}` : null,
    mp.medicalNotes ? `*Notes:* ${mp.medicalNotes}` : null,
    `\n*Live map:* ${url}`,
  ].filter(Boolean).join("\n");
  const encoded = encodeURIComponent(lines);
  return `
    <a class="button success full" href="https://wa.me/?text=${encoded}" target="_blank" rel="noopener">Share on WhatsApp</a>
  `;
}

// ---- Profile actions ----

function _saveMissingPerson() {
  const prev = state.missingPerson?.category || "";
  state.missingPerson = {
    name: document.getElementById("mpName")?.value.trim() || "",
    age: document.getElementById("mpAge")?.value.trim() || "",
    gender: document.getElementById("mpGender")?.value.trim() || "",
    category: document.getElementById("mpCategory")?.value || "",
    description: document.getElementById("mpDescription")?.value.trim() || "",
    clothing: document.getElementById("mpClothing")?.value.trim() || "",
    medicalNotes: document.getElementById("mpMedical")?.value.trim() || "",
    photoData: state.missingPerson?.photoData || "",
  };
  addAudit("missing_person_updated", null, { name: state.missingPerson.name, category: state.missingPerson.category });
  saveState();
  // Re-render Koester rings when category changes.
  if (prev !== state.missingPerson.category) {
    document.dispatchEvent(new CustomEvent("esti:render-last-seen"));
  }
  renderPanel();
  showToast("Missing person profile saved.");
}

async function _handleMissingPersonPhoto(event) {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const dataUrl = await _compressPhoto(file, 360, 0.72);
    if (!state.missingPerson) state.missingPerson = defaultMissingPerson();
    state.missingPerson.photoData = dataUrl;
    addAudit("missing_person_photo_set", null, {});
    saveState();
    renderPanel();
    showToast("Photo saved.");
  } catch {
    showToast("Could not load that image.");
  }
}

function _compressPhoto(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function _saveProfileFromCommand() {
  const previousContact = state.profile.contact;
  const nextContact = document.getElementById("profileContact").value.trim();
  state.profile.name = document.getElementById("profileName").value.trim();
  state.profile.contact = nextContact;
  state.profile.team = document.getElementById("profileTeam").value.trim();
  state.profile.lastSeenAt = new Date().toISOString();
  if (previousContact !== nextContact) {
    state.profile.phoneVerified = false;
    state.profile.verifiedAt = "";
    state.profile.verificationCode = "";
    state.profile.verificationSentAt = "";
  }
  addAudit("identity_updated", null, { phoneVerified: state.profile.phoneVerified });
  saveState();
  renderPanel();
  showToast("Identity saved.");
}

function _sendVerificationCode() {
  const phone = document.getElementById("profileContact").value.trim();
  if (!phone) { showToast("Enter a phone number first."); return; }
  state.profile.name = document.getElementById("profileName").value.trim();
  state.profile.contact = phone;
  state.profile.team = document.getElementById("profileTeam").value.trim();
  state.profile.verificationCode = String(Math.floor(100000 + Math.random() * 900000));
  state.profile.verificationSentAt = new Date().toISOString();
  state.profile.phoneVerified = false;
  state.profile.verifiedAt = "";
  addAudit("phone_verification_requested", null, { phone: maskPhone(phone), mode: "demo_local_code" });
  saveState();
  renderPanel();
  showToast("Demo code generated.");
}

function _verifyPhoneCode() {
  const code = document.getElementById("phoneCode").value.trim();
  if (!state.profile.verificationCode || code !== state.profile.verificationCode) {
    addAudit("phone_verification_failed", null, { phone: maskPhone(state.profile.contact) });
    saveState();
    showToast("Verification code did not match.");
    return;
  }
  state.profile.phoneVerified = true;
  state.profile.verifiedAt = new Date().toISOString();
  state.profile.verificationCode = "";
  state.profile.verificationSentAt = "";
  addAudit("phone_verified", null, { phone: maskPhone(state.profile.contact) });
  saveState();
  renderPanel();
  showToast("Phone marked verified.");
}
