const SEARCH_KEY_PREFIX = "esti:search:";
const SEARCH_INDEX_KEY = "esti:searches:index";

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

async function redisLRange(key, start, stop) {
  const { url, token } = getRedisConfig();
  if (!url || !token) throw new Error("Redis not configured");
  const res = await fetch(`${url}/lrange/${encodeURIComponent(key)}/${start}/${stop}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Redis lrange failed: ${res.status}`);
  const payload = await res.json();
  return Array.isArray(payload.result) ? payload.result : [];
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

  try {
    // Fetch up to 100 most recent search IDs (index is an LPUSH list, newest first)
    const searchIds = await redisLRange(SEARCH_INDEX_KEY, 0, 99);

    // Deduplicate (LPUSH can create duplicates if called multiple times for same id)
    const unique = [...new Set(searchIds)];

    // Fetch meta for each in parallel
    const metas = await Promise.all(
      unique.map((id) => redisGet(`${SEARCH_KEY_PREFIX}${id}:meta`).catch(() => null))
    );

    const searches = metas
      .filter(Boolean)
      .filter((m) => m.active !== false)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    json(res, 200, { ok: true, searches });
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : "Server error" });
  }
};
