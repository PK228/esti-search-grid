const crypto = require("crypto");

const RATE_LIMIT_SECONDS = 15;
const IDLE_MS = 30 * 60 * 1000;
const MAX_POSITIONS = 600;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(body));
}

function getRedisConfig() {
  return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
}

async function redisGet(key) {
  const { url, token } = getRedisConfig();
  if (!url || !token) throw new Error("Redis not configured");
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Redis get failed: ${res.status}`);
  const payload = await res.json();
  if (!payload.result) return {};
  try {
    const parsed = JSON.parse(payload.result);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function redisSet(key, value) {
  const { url, token } = getRedisConfig();
  if (!url || !token) throw new Error("Redis not configured");
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Redis set failed: ${res.status}`);
}

// Returns true if the caller is allowed (key was newly set), false if rate-limited (key already existed).
// Fails open (returns true) if Redis is unavailable.
async function redisRateLimitNX(key, ttlSeconds) {
  const { url, token } = getRedisConfig();
  if (!url || !token) return true;
  try {
    const res = await fetch(`${url}/set/${encodeURIComponent(key)}?ex=${ttlSeconds}&nx=`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify("1"),
    });
    if (!res.ok) return true;
    const payload = await res.json();
    return payload.result === "OK";
  } catch {
    return true;
  }
}

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function tokenLookupKey(tokenHash) {
  return `esti:volunteer-token:${tokenHash}`;
}

function volunteersKey(searchId) {
  if (searchId && /^[a-zA-Z0-9_-]{1,64}$/.test(searchId)) {
    return `esti:search:${searchId}:volunteers`;
  }
  return "esti:search:default:volunteers";
}

function stateKey(searchId) {
  if (searchId && /^[a-zA-Z0-9_-]{1,64}$/.test(searchId)) {
    return `esti:search:${searchId}:state`;
  }
  return "esti-search-grid:shared-state:v1";
}

function positionsKey(searchId) {
  if (searchId && /^[a-zA-Z0-9_-]{1,64}$/.test(searchId)) {
    return `esti:search:${searchId}:positions`;
  }
  return "esti-search-grid:positions:v1";
}

// Find volunteer by raw token across a searchId namespace
async function findVolunteer(rawToken, searchId) {
  const tokenHash = hashToken(rawToken);
  const requestedSearchId = searchId || "default";
  const key = volunteersKey(requestedSearchId);
  const volunteers = await redisGet(key);
  const volunteer = Object.values(volunteers).find((v) => v.tokenHash === tokenHash) || null;
  if (volunteer) {
    return { volunteer, searchId: volunteer.searchId || requestedSearchId };
  }

  const lookup = await redisGet(tokenLookupKey(tokenHash));
  const indexedSearchId = lookup?.searchId;
  if (!indexedSearchId || indexedSearchId === requestedSearchId) {
    return { volunteer: null, searchId: requestedSearchId };
  }

  const indexedVolunteers = await redisGet(volunteersKey(indexedSearchId));
  const indexedVolunteer = lookup?.volunteerId
    ? indexedVolunteers[lookup.volunteerId]
    : Object.values(indexedVolunteers).find((v) => v.tokenHash === tokenHash);

  return indexedVolunteer
    ? { volunteer: indexedVolunteer, searchId: indexedVolunteer.searchId || indexedSearchId }
    : { volunteer: null, searchId: requestedSearchId };
}

function prune(map) {
  const now = Date.now();
  const fresh = {};
  Object.entries(map || {}).forEach(([id, pos]) => {
    if (pos && typeof pos.updatedAt === "number" && now - pos.updatedAt < IDLE_MS) {
      fresh[id] = pos;
    }
  });
  return fresh;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { json(res, 200, { ok: true }); return; }

  const urlPath = req.url?.split("?")[0] || "";

  try {
    // GET /api/volunteer?token=<raw>&s=<searchId>
    // Returns public volunteer info for the tracking page to render its greeting
    if (req.method === "GET") {
      const rawToken = req.query?.token || "";
      const searchId = req.query?.s || "default";
      if (!rawToken) { json(res, 400, { ok: false, error: "token required" }); return; }

      const resolved = await findVolunteer(rawToken, searchId);
      const volunteer = resolved.volunteer;
      if (!volunteer) { json(res, 403, { ok: false, error: "Invalid or expired link" }); return; }

      json(res, 200, {
        ok: true,
        volunteer: {
          firstName: volunteer.firstName,
          lastName: volunteer.lastName,
          assignedCell: volunteer.assignedCell,
          assignedCellCoords: volunteer.assignedCellCoords,
          assignedCellBounds: volunteer.assignedCellBounds || null,
          status: volunteer.status,
          searchId: resolved.searchId || volunteer.searchId,
          dispatchPhone: process.env.DISPATCH_PHONE || "",
        },
      });
      return;
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const rawToken = String(payload.token || "");
      const requestedSearchId = String(payload.searchId || "default").slice(0, 64);

      if (!rawToken) { json(res, 400, { ok: false, error: "token required" }); return; }

      const resolved = await findVolunteer(rawToken, requestedSearchId);
      const volunteer = resolved.volunteer;
      if (!volunteer) { json(res, 403, { ok: false, error: "Invalid or expired link" }); return; }
      const searchId = resolved.searchId || requestedSearchId;

      // POST /api/volunteer or /api/volunteer/position — position ping.
      const isPositionPing =
        urlPath.endsWith("/api/volunteer") ||
        urlPath.endsWith("/api/volunteer/") ||
        urlPath.endsWith("/position");
      if (isPositionPing) {
        const lat = Number(payload.lat);
        const lng = Number(payload.lng);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
          json(res, 400, { ok: false, error: "Invalid lat" }); return;
        }
        if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
          json(res, 400, { ok: false, error: "Invalid lng" }); return;
        }

        // Rate-limit per volunteer using Redis NX TTL (survives cold starts)
        const allowed = await redisRateLimitNX(`esti:ratelimit:${volunteer.id}`, RATE_LIMIT_SECONDS);
        if (!allowed) {
          json(res, 429, { ok: false, error: "Too many pings" }); return;
        }
        const now = Date.now();
        const accuracy = Number(payload.accuracy);
        const pKey = positionsKey(searchId);
        const positions = prune(await redisGet(pKey));
        const position = {
          userId: volunteer.id,
          name: `${volunteer.firstName} ${volunteer.lastName}`.trim(),
          team: volunteer.assignedCell || "",
          lat,
          lng,
          accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
          updatedAt: now,
        };
        positions[volunteer.id] = position;

        const entries = Object.entries(positions);
        const capped = entries.length > MAX_POSITIONS
          ? Object.fromEntries(entries.slice(-MAX_POSITIONS))
          : positions;

        await redisSet(pKey, capped);
        json(res, 200, { ok: true, position });
        return;
      }

      // POST /api/volunteer/complete — volunteer marks search done
      if (urlPath.endsWith("/complete")) {
        const vKey = volunteersKey(searchId);
        const volunteers = await redisGet(vKey);
        if (volunteers[volunteer.id]) {
          volunteers[volunteer.id].status = "completed";
          volunteers[volunteer.id].completedAt = Date.now();
          await redisSet(vKey, volunteers);
        }
        json(res, 200, { ok: true });
        return;
      }

      // POST /api/volunteer/backup — volunteer requests backup
      if (urlPath.endsWith("/backup")) {
        const vKey = volunteersKey(searchId);
        const volunteers = await redisGet(vKey);
        if (volunteers[volunteer.id]) {
          volunteers[volunteer.id].status = "backup_needed";
          volunteers[volunteer.id].backupRequestedAt = Date.now();
          await redisSet(vKey, volunteers);
        }
        json(res, 200, { ok: true });
        return;
      }

      // POST /api/volunteer/found — volunteer reports found missing person
      if (urlPath.endsWith("/found")) {
        const vKey = volunteersKey(searchId);
        const volunteers = await redisGet(vKey);
        if (volunteers[volunteer.id]) {
          volunteers[volunteer.id].status = "found";
          volunteers[volunteer.id].foundAt = Date.now();
          await redisSet(vKey, volunteers);
        }
        json(res, 200, { ok: true });
        return;
      }

      // POST /api/volunteer/note — volunteer sends a note to dispatch
      if (urlPath.endsWith("/note")) {
        const noteText = String(payload.note || "").trim().slice(0, 1000);
        if (!noteText) { json(res, 400, { ok: false, error: "note required" }); return; }
        const vKey = volunteersKey(searchId);
        const volunteers = await redisGet(vKey);
        if (volunteers[volunteer.id]) {
          if (!Array.isArray(volunteers[volunteer.id].notes)) {
            volunteers[volunteer.id].notes = [];
          }
          volunteers[volunteer.id].notes.push({ text: noteText, sentAt: Date.now() });
          await redisSet(vKey, volunteers);
        }
        json(res, 200, { ok: true });
        return;
      }

      // POST /api/volunteer/clue — volunteer reports a clue; added to shared state
      if (urlPath.endsWith("/clue")) {
        const description = String(payload.description || "").trim().slice(0, 400);
        if (!description) { json(res, 400, { ok: false, error: "description required" }); return; }
        const lat = Number(payload.lat);
        const lng = Number(payload.lng);
        const sKey = stateKey(searchId);
        const currentState = await redisGet(sKey);
        const clues = Array.isArray(currentState?.clues) ? currentState.clues : [];
        const clueId = `vol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        clues.push({
          id: clueId,
          gridId: volunteer.assignedCell || null,
          type: "other",
          description,
          lat: Number.isFinite(lat) ? lat : null,
          lng: Number.isFinite(lng) ? lng : null,
          photoData: "",
          loggedBy: { name: `${volunteer.firstName} ${volunteer.lastName}`.trim(), userId: volunteer.id },
          loggedAt: new Date().toISOString(),
          resolved: false,
          resolvedBy: "",
          resolvedAt: "",
        });
        if (currentState && typeof currentState === "object") {
          currentState.clues = clues.slice(-200);
          await redisSet(sKey, currentState);
        }
        json(res, 200, { ok: true, clueId });
        return;
      }
    }

    json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : "Unknown error" });
  }
};
