const SEARCH_KEY_PREFIX = "esti:search:";

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

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { json(res, 200, { ok: true }); return; }
  if (req.method !== "GET") { json(res, 405, { ok: false, error: "Method not allowed" }); return; }

  const searchId = req.query?.s || "";
  if (!searchId || !/^[a-zA-Z0-9_-]{1,64}$/.test(searchId)) {
    json(res, 400, { ok: false, error: "Valid s= param required" });
    return;
  }

  try {
    const meta = await redisGet(`${SEARCH_KEY_PREFIX}${searchId}:meta`);
    if (!meta) { json(res, 404, { ok: false, error: "Search not found" }); return; }
    json(res, 200, { ok: true, meta });
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : "Server error" });
  }
};
