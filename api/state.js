const LEGACY_STATE_KEY = "esti-search-grid:shared-state:v1";
const MAX_AUDIT_EVENTS = 1500;
const MAX_INCIDENTS = 500;
const MAX_MISSING_STREETS = 500;
const MAX_ZONES = 1000;
const MAX_BOUNDARY_POINTS = 250;

function stateKey(searchId) {
  if (searchId && /^[a-zA-Z0-9_-]{1,64}$/.test(searchId)) {
    return `esti:search:${searchId}:state`;
  }
  return LEGACY_STATE_KEY;
}

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
    return null;
  }

  return JSON.parse(payload.result);
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

const MAX_PHOTO_BYTES = 200_000; // ~150 KB compressed JPEG

function sanitizePhoto(value) {
  if (typeof value !== "string") return "";
  if (!value.startsWith("data:image/")) return "";
  return value.length <= MAX_PHOTO_BYTES ? value : "";
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
    address: typeof input.address === "string" ? input.address.slice(0, 200) : "",
    setBy: typeof input.setBy === "string" ? input.setBy.slice(0, 80) : "",
    updatedAt:
      typeof input.updatedAt === "string"
        ? input.updatedAt
        : new Date().toISOString(),
    photoData: sanitizePhoto(input.photoData),
  };
}

function sanitizeMissingPerson(input) {
  if (!input || typeof input !== "object") return null;
  return {
    name: typeof input.name === "string" ? input.name.slice(0, 120) : "",
    age: typeof input.age === "string" ? input.age.slice(0, 10) : "",
    gender: typeof input.gender === "string" ? input.gender.slice(0, 30) : "",
    category: typeof input.category === "string" ? input.category.slice(0, 30) : "",
    description: typeof input.description === "string" ? input.description.slice(0, 500) : "",
    clothing: typeof input.clothing === "string" ? input.clothing.slice(0, 300) : "",
    medicalNotes: typeof input.medicalNotes === "string" ? input.medicalNotes.slice(0, 500) : "",
    photoData: sanitizePhoto(input.photoData),
  };
}

function sanitizeBoundary(input) {
  if (!Array.isArray(input) || input.length < 4) return null;
  const points = input.slice(0, MAX_BOUNDARY_POINTS).map((point) => {
    if (!Array.isArray(point) || point.length < 2) return null;
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    return [
      Math.round(lng * 100000) / 100000,
      Math.round(lat * 100000) / 100000,
    ];
  }).filter(Boolean);

  if (points.length < 4) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    points.push([...first]);
  }
  return points;
}

function sanitizeClue(input) {
  if (!input || typeof input !== "object" || typeof input.id !== "string") return null;
  return {
    id: input.id.slice(0, 80),
    gridId: typeof input.gridId === "string" ? input.gridId.slice(0, 10) : null,
    type: typeof input.type === "string" ? input.type.slice(0, 30) : "other",
    description: typeof input.description === "string" ? input.description.slice(0, 400) : "",
    lat: Number.isFinite(Number(input.lat)) ? Number(input.lat) : null,
    lng: Number.isFinite(Number(input.lng)) ? Number(input.lng) : null,
    photoData: sanitizePhoto(input.photoData),
    loggedBy: input.loggedBy && typeof input.loggedBy === "object"
      ? { name: String(input.loggedBy.name || "").slice(0, 80), userId: String(input.loggedBy.userId || "").slice(0, 60) }
      : { name: "", userId: "" },
    loggedAt: typeof input.loggedAt === "string" ? input.loggedAt : new Date().toISOString(),
    resolved: Boolean(input.resolved),
    resolvedBy: typeof input.resolvedBy === "string" ? input.resolvedBy.slice(0, 80) : "",
    resolvedAt: typeof input.resolvedAt === "string" ? input.resolvedAt : "",
  };
}

function sanitizeZoneRecord(input) {
  if (!input || typeof input !== "object") return null;
  return {
    status: typeof input.status === "string" ? input.status.slice(0, 30) : "UNASSIGNED",
    assignedTeam: typeof input.assignedTeam === "string" ? input.assignedTeam.slice(0, 80) : "",
    captain: typeof input.captain === "string" ? input.captain.slice(0, 80) : "",
    unitsVisited: typeof input.unitsVisited === "string" ? input.unitsVisited.slice(0, 200) : "",
    revisitReason: typeof input.revisitReason === "string" ? input.revisitReason.slice(0, 400) : "",
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : "",
    updatedBy: typeof input.updatedBy === "string" ? input.updatedBy.slice(0, 80) : "",
  };
}

function sanitizeZones(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input)
      .slice(0, MAX_ZONES)
      .map(([id, record]) => {
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return null;
        const sanitized = sanitizeZoneRecord(record);
        return sanitized ? [id, sanitized] : null;
      })
      .filter(Boolean),
  );
}

function sanitizeMissingStreet(input) {
  if (!input || typeof input !== "object") return null;
  return {
    id: typeof input.id === "string" ? input.id.slice(0, 60) : "",
    timestamp: typeof input.timestamp === "string" ? input.timestamp : new Date().toISOString(),
    submittedBy: typeof input.submittedBy === "string" ? input.submittedBy.slice(0, 80) : "",
    neighborhood: typeof input.neighborhood === "string" ? input.neighborhood.slice(0, 80) : "",
    street: typeof input.street === "string" ? input.street.slice(0, 120) : "",
    intersection: typeof input.intersection === "string" ? input.intersection.slice(0, 160) : "",
    estimatedUnits: typeof input.estimatedUnits === "string" ? input.estimatedUnits.slice(0, 20) : "",
    notes: typeof input.notes === "string" ? input.notes.slice(0, 400) : "",
    status: typeof input.status === "string" ? input.status.slice(0, 30) : "PENDING",
  };
}

function sanitizeState(input) {
  const now = new Date().toISOString();
  const cells = input && typeof input.cells === "object" ? input.cells : {};
  const audit = Array.isArray(input?.audit) ? input.audit.slice(-MAX_AUDIT_EVENTS) : [];
  const incidents = Array.isArray(input?.incidents)
    ? input.incidents.slice(-MAX_INCIDENTS)
    : [];

  const lastSeenTrail = Array.isArray(input?.lastSeenTrail)
    ? input.lastSeenTrail.slice(-10).map(sanitizeLastSeen).filter(Boolean)
    : [];

  const clues = Array.isArray(input?.clues)
    ? input.clues.slice(-200).map(sanitizeClue).filter(Boolean)
    : [];

  const missingStreets = Array.isArray(input?.missingStreets)
    ? input.missingStreets.slice(-MAX_MISSING_STREETS).map(sanitizeMissingStreet).filter(Boolean)
    : [];

  return {
    version: 2,
    updatedAt: now,
    cells,
    zones: sanitizeZones(input?.zones),
    missingStreets,
    audit,
    incidents,
    lastSeen: sanitizeLastSeen(input?.lastSeen),
    lastSeenTrail,
    clues,
    missingPerson: sanitizeMissingPerson(input?.missingPerson),
    customExtendedBoundary: sanitizeBoundary(input?.customExtendedBoundary),
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
      const searchId = req.query?.s || null;
      const key = stateKey(searchId);
      let state = await redisGet(key);
      // If nothing found under the specific key, fall back to the legacy key so
      // volunteer pages can read state saved by a dispatcher with no search ID set.
      if (!state && key !== LEGACY_STATE_KEY) {
        state = await redisGet(LEGACY_STATE_KEY);
      }
      json(res, 200, { ok: true, state: state || sanitizeState({}) });
      return;
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const searchId = payload?.searchId || req.query?.s || null;
      const key = stateKey(searchId);
      const state = sanitizeState(payload);
      await redisSet(key, state);
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
