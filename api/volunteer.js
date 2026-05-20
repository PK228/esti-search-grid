const crypto = require("crypto");

// Per-token rate limiting (in-memory; resets on cold start, good enough for abuse prevention)
const lastPingAt = new Map();
const RATE_LIMIT_MS = 15 * 1000;
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

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function volunteersKey(searchId) {
  if (searchId && /^[a-zA-Z0-9_-]{1,64}$/.test(searchId)) {
    return `esti:search:${searchId}:volunteers`;
  }
  return "esti:search:default:volunteers";
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
  const key = volunteersKey(searchId || "default");
  const volunteers = await redisGet(key);
  return Object.values(volunteers).find((v) => v.tokenHash === tokenHash) || null;
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

      const volunteer = await findVolunteer(rawToken, searchId);
      if (!volunteer) { json(res, 403, { ok: false, error: "Invalid or expired link" }); return; }

      json(res, 200, {
        ok: true,
        volunteer: {
          firstName: volunteer.firstName,
          lastName: volunteer.lastName,
          assignedCell: volunteer.assignedCell,
          assignedCellCoords: volunteer.assignedCellCoords,
          status: volunteer.status,
          searchId: volunteer.searchId,
          dispatchPhone: process.env.DISPATCH_PHONE || "",
        },
      });
      return;
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const rawToken = String(payload.token || "");
      const searchId = String(payload.searchId || "default").slice(0, 64);

      if (!rawToken) { json(res, 400, { ok: false, error: "token required" }); return; }

      const volunteer = await findVolunteer(rawToken, searchId);
      if (!volunteer) { json(res, 403, { ok: false, error: "Invalid or expired link" }); return; }

      // POST /api/volunteer — position ping (path ends in /position or just default)
      if (!urlPath.endsWith("/complete")) {
        const lat = Number(payload.lat);
        const lng = Number(payload.lng);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
          json(res, 400, { ok: false, error: "Invalid lat" }); return;
        }
        if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
          json(res, 400, { ok: false, error: "Invalid lng" }); return;
        }

        // Rate-limit per volunteer id
        const now = Date.now();
        const last = lastPingAt.get(volunteer.id) || 0;
        if (now - last < RATE_LIMIT_MS) {
          json(res, 429, { ok: false, error: "Too many pings" }); return;
        }
        lastPingAt.set(volunteer.id, now);

        const accuracy = Number(payload.accuracy);
        const pKey = positionsKey(searchId);
        const positions = prune(await redisGet(pKey));
        positions[volunteer.id] = {
          userId: volunteer.id,
          name: `${volunteer.firstName} ${volunteer.lastName}`.trim(),
          team: volunteer.assignedCell || "",
          lat,
          lng,
          accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
          updatedAt: now,
        };

        const entries = Object.entries(positions);
        const capped = entries.length > MAX_POSITIONS
          ? Object.fromEntries(entries.slice(-MAX_POSITIONS))
          : positions;

        await redisSet(pKey, capped);
        json(res, 200, { ok: true });
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
    }

    json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : "Unknown error" });
  }
};
