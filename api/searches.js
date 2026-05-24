const SEARCH_KEY_PREFIX = "esti:search:";
const SEARCH_INDEX_KEY = "esti:searches:index";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(body));
}

function getRedisConfig() {
  return {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  };
}

async function redisSet(key, value) {
  const { url, token } = getRedisConfig();
  if (!url || !token) throw new Error("Redis is not configured");
  const response = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Redis set failed: ${response.status}`);
}

async function redisLPush(key, value) {
  const { url, token } = getRedisConfig();
  if (!url || !token) throw new Error("Redis is not configured");
  const response = await fetch(`${url}/lpush/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Redis lpush failed: ${response.status}`);
}

function makeSearchId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function sanitizeString(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function sanitizeCellKm(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.1 || n > 5) return 0.5;
  return Math.round(n * 100) / 100;
}

function sanitizeBoundary(input) {
  if (!Array.isArray(input) || input.length < 4) return null;
  const points = input.slice(0, 250).map((pt) => {
    if (!Array.isArray(pt) || pt.length < 2) return null;
    const lng = Number(pt[0]);
    const lat = Number(pt[1]);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    return [Math.round(lng * 100000) / 100000, Math.round(lat * 100000) / 100000];
  }).filter(Boolean);
  if (points.length < 4) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
  return points;
}

async function readBody(req) {
  if (req.body) {
    return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};

    const orgName = sanitizeString(body.orgName, 120);
    const orgCity = sanitizeString(body.orgCity, 80);
    const label = sanitizeString(body.label, 200);
    const cellKm = sanitizeCellKm(body.cellKm);
    const boundary = sanitizeBoundary(body.boundary);

    const searchId = makeSearchId();
    const now = new Date().toISOString();

    const meta = {
      searchId,
      orgName,
      orgCity,
      label,
      createdAt: now,
      active: true,
      ...(boundary ? { boundary } : {}),
      cellKm,
    };

    const initialState = {
      version: 2,
      updatedAt: now,
      cells: {},
      zones: {},
      missingStreets: [],
      audit: [],
      incidents: [],
      lastSeen: null,
      lastSeenTrail: [],
      clues: [],
      missingPerson: null,
      customExtendedBoundary: null,
    };

    await Promise.all([
      redisSet(`${SEARCH_KEY_PREFIX}${searchId}:meta`, meta),
      redisSet(`${SEARCH_KEY_PREFIX}${searchId}:state`, initialState),
      redisLPush(SEARCH_INDEX_KEY, searchId),
    ]);

    const origin = req.headers.origin || req.headers.host || "";
    const baseUrl = origin.startsWith("http") ? origin : `https://${origin}`;
    const url = `${baseUrl}/?s=${searchId}`;

    json(res, 201, { ok: true, searchId, url, meta });
  } catch (error) {
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown backend error",
    });
  }
};
