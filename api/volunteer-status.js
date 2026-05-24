const crypto = require("crypto");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
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
  if (!payload.result) return null;
  try { return JSON.parse(payload.result); } catch { return null; }
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

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { json(res, 200, { ok: true }); return; }
  if (req.method !== "GET") { json(res, 405, { ok: false, error: "Method not allowed" }); return; }

  const rawToken = String(req.query?.token || "").slice(0, 200);
  if (!rawToken) { json(res, 400, { ok: false, error: "token required" }); return; }

  const searchId = String(req.query?.s || "default").slice(0, 64);

  try {
    // Look up which volunteerId this token belongs to
    const tokenHash   = hashToken(rawToken);
    const tokenRecord = await redisGet(`esti:volunteer-token:${tokenHash}`);
    if (!tokenRecord || !tokenRecord.volunteerId) {
      json(res, 404, { ok: false, error: "Not found" }); return;
    }

    const { volunteerId, searchId: recordSearchId } = tokenRecord;
    const sid = recordSearchId || searchId;

    const volunteers = await redisGet(volunteersKey(sid));
    if (!volunteers || !volunteers[volunteerId]) {
      json(res, 404, { ok: false, error: "Volunteer not found" }); return;
    }

    const v = volunteers[volunteerId];
    if (v.assignedCell) {
      json(res, 200, {
        ok: true,
        assigned: true,
        cellId: v.assignedCell,
        cellCoords: v.assignedCellCoords || null,
        cellBounds: v.assignedCellBounds || null,
        searchId: sid,
      });
    } else {
      json(res, 200, { ok: true, assigned: false });
    }
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};
