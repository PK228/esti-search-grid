const STATE_KEY = "esti-search-grid:shared-state:v1";
const MAX_AUDIT_EVENTS = 1500;
const MAX_INCIDENTS = 500;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(body));
}

function getRedisConfig() {
  return {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  };
}

async function redisGet() {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error("Redis is not configured");
  }

  const response = await fetch(`${url}/get/${encodeURIComponent(STATE_KEY)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Redis get failed: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.result) {
    return null;
  }

  return JSON.parse(payload.result);
}

async function redisSet(value) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error("Redis is not configured");
  }

  const response = await fetch(`${url}/set/${encodeURIComponent(STATE_KEY)}`, {
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

function sanitizeLastSeen(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return null;
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return null;
  }
  return {
    lat,
    lng,
    time: typeof input.time === "string" ? input.time.slice(0, 40) : "",
    note: typeof input.note === "string" ? input.note.slice(0, 300) : "",
    setBy: typeof input.setBy === "string" ? input.setBy.slice(0, 80) : "",
    updatedAt:
      typeof input.updatedAt === "string"
        ? input.updatedAt
        : new Date().toISOString(),
  };
}

function sanitizeState(input) {
  const now = new Date().toISOString();
  const cells = input && typeof input.cells === "object" ? input.cells : {};
  const audit = Array.isArray(input?.audit) ? input.audit.slice(-MAX_AUDIT_EVENTS) : [];
  const incidents = Array.isArray(input?.incidents)
    ? input.incidents.slice(-MAX_INCIDENTS)
    : [];

  return {
    version: 1,
    updatedAt: now,
    cells,
    audit,
    incidents,
    lastSeen: sanitizeLastSeen(input?.lastSeen),
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
      const state = (await redisGet()) || sanitizeState({});
      json(res, 200, { ok: true, state });
      return;
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const state = sanitizeState(payload);
      await redisSet(state);
      json(res, 200, { ok: true, state });
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
