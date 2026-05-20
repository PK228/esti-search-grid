const crypto = require("crypto");

function volunteersKey(searchId) {
  if (searchId && /^[a-zA-Z0-9_-]{1,64}$/.test(searchId)) {
    return `esti:search:${searchId}:volunteers`;
  }
  return "esti:search:default:volunteers";
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-positions-key");
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

function generateToken() {
  return crypto.randomBytes(12).toString("base64url");
}

function sanitizeVolunteer(input) {
  if (!input || typeof input !== "object") return null;
  const firstName = String(input.firstName || "").trim().slice(0, 80);
  const lastName = String(input.lastName || "").trim().slice(0, 80);
  const phone = String(input.phone || "").replace(/[^\d+\-().# ]/g, "").slice(0, 30);
  const email = String(input.email || "").trim().slice(0, 120);
  if (!firstName || !lastName) return null;
  return { firstName, lastName, phone, email };
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "esti.app";
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { json(res, 200, { ok: true }); return; }

  try {
    // POST — register a new volunteer
    if (req.method === "POST") {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const fields = sanitizeVolunteer(payload);
      if (!fields) { json(res, 400, { ok: false, error: "firstName and lastName are required" }); return; }

      const searchId = String(payload.searchId || "").slice(0, 64) || "default";
      const key = volunteersKey(searchId);
      const volunteers = await redisGet(key);

      const rawToken = generateToken();
      const tokenHash = hashToken(rawToken);
      const volunteerId = crypto.randomBytes(6).toString("hex");
      const trackingUrl = `${baseUrl(req)}/v/${rawToken}`;

      volunteers[volunteerId] = {
        id: volunteerId,
        ...fields,
        tokenHash,
        trackingUrl,
        assignedCell: null,
        assignedCellCoords: null,
        status: "queued",
        createdAt: Date.now(),
        searchId,
      };

      await redisSet(key, volunteers);
      json(res, 200, { ok: true, volunteerId, token: rawToken, trackingUrl, searchId });
      return;
    }

    // GET — dispatcher queue (requires positions key)
    if (req.method === "GET") {
      const configured = process.env.POSITIONS_READ_KEY || "";
      const provided = req.headers["x-positions-key"] || "";
      if (!configured || provided !== configured) {
        json(res, 403, { ok: false, error: "Restricted" }); return;
      }
      const searchId = req.query?.s || "default";
      const key = volunteersKey(searchId);
      const volunteers = await redisGet(key);
      // Strip tokenHash before returning
      const safe = Object.values(volunteers).map(({ tokenHash: _t, ...v }) => v);
      json(res, 200, { ok: true, volunteers: safe });
      return;
    }

    // PATCH — dispatcher assigns a cell to a volunteer
    if (req.method === "PATCH") {
      const configured = process.env.POSITIONS_READ_KEY || "";
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const provided = String(payload.dispatchKey || "");
      if (!configured || provided !== configured) {
        json(res, 403, { ok: false, error: "Restricted" }); return;
      }
      const { volunteerId, assignedCell, assignedCellCoords, searchId = "default" } = payload;
      if (!volunteerId) { json(res, 400, { ok: false, error: "volunteerId required" }); return; }

      const key = volunteersKey(searchId);
      const volunteers = await redisGet(key);
      if (!volunteers[volunteerId]) { json(res, 404, { ok: false, error: "Volunteer not found" }); return; }

      const cellValue = String(assignedCell || "").trim().slice(0, 20);
      volunteers[volunteerId].assignedCell = cellValue || null;
      volunteers[volunteerId].assignedCellCoords = cellValue ? (assignedCellCoords || null) : null;
      volunteers[volunteerId].status = cellValue ? "assigned" : "queued";
      volunteers[volunteerId].assignedAt = cellValue ? Date.now() : null;

      await redisSet(key, volunteers);
      const { tokenHash: _t, ...safe } = volunteers[volunteerId];
      json(res, 200, { ok: true, volunteer: safe });
      return;
    }

    json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : "Unknown error" });
  }
};
