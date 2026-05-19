const LEGACY_POSITIONS_KEY = "esti-search-grid:positions:v1";
const IDLE_MS = 10 * 60 * 1000;
const MAX_POSITIONS = 600;

function positionsKey(searchId) {
  if (searchId && /^[a-zA-Z0-9_-]{1,64}$/.test(searchId)) {
    return `esti:search:${searchId}:positions`;
  }
  return LEGACY_POSITIONS_KEY;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-positions-key");
  res.end(JSON.stringify(body));
}

function getRedisConfig() {
  return {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  };
}

async function redisGet(key) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error("Redis is not configured");
  }

  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Redis get failed: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.result) {
    return {};
  }

  try {
    const parsed = JSON.parse(payload.result);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function redisSet(key, value) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error("Redis is not configured");
  }

  const response = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });

  if (!response.ok) {
    throw new Error(`Redis set failed: ${response.status}`);
  }
}

// Volunteers idle longer than IDLE_MS are dropped, so a phone that stops
// sharing fades off every map within ten minutes.
function prune(map) {
  const now = Date.now();
  const fresh = {};
  Object.entries(map || {}).forEach(([id, position]) => {
    if (
      position &&
      typeof position === "object" &&
      typeof position.updatedAt === "number" &&
      now - position.updatedAt < IDLE_MS
    ) {
      fresh[id] = position;
    }
  });
  return fresh;
}

function sanitizePosition(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const userId = String(input.userId || "").slice(0, 100);
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!userId) {
    return null;
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return null;
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return null;
  }
  const accuracy = Number(input.accuracy);
  return {
    userId,
    name: String(input.name || "Volunteer").slice(0, 80),
    team: String(input.team || "").slice(0, 80),
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    updatedAt: Date.now(),
  };
}

async function readBody(req) {
  if (req.body) {
    return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    json(res, 200, { ok: true });
    return;
  }

  try {
    if (req.method === "GET") {
      // Viewing volunteer locations is dispatcher-only: the request must carry
      // the secret read key. The key lives only in POSITIONS_READ_KEY (a server
      // env var) and in each dispatcher's head — never in the shipped app code.
      const configured = process.env.POSITIONS_READ_KEY || "";
      const provided = req.headers["x-positions-key"] || "";
      if (!configured || provided !== configured) {
        json(res, 403, { ok: false, error: "Location feed is restricted" });
        return;
      }
      const searchId = req.query?.s || null;
      const key = positionsKey(searchId);
      const positions = prune(await redisGet(key));
      json(res, 200, { ok: true, positions: Object.values(positions) });
      return;
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const position = sanitizePosition(payload);
      if (!position) {
        json(res, 400, { ok: false, error: "Invalid position" });
        return;
      }

      const searchId = payload?.searchId || req.query?.s || null;
      const key = positionsKey(searchId);
      const positions = prune(await redisGet(key));
      positions[position.userId] = position;

      const entries = Object.entries(positions);
      const capped =
        entries.length > MAX_POSITIONS
          ? Object.fromEntries(entries.slice(-MAX_POSITIONS))
          : positions;

      await redisSet(key, capped);
      json(res, 200, { ok: true, positions: Object.values(capped) });
      return;
    }

    json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown backend error",
    });
  }
};
