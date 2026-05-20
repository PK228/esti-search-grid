function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { json(res, 200, { ok: true }); return; }
  if (req.method !== "POST") { json(res, 405, { ok: false, error: "Method not allowed" }); return; }

  try {
    const raw = await readBody(req);
    const { pin } = raw ? JSON.parse(raw) : {};

    const expectedPin = process.env.DISPATCHER_PIN || "2468";

    if (typeof pin !== "string" || pin.trim() !== expectedPin) {
      await new Promise((r) => setTimeout(r, 400));
      json(res, 401, { ok: false, error: "Incorrect PIN." });
      return;
    }

    // Return the positions key so the volunteer map unlocks automatically.
    json(res, 200, {
      ok: true,
      positionsKey: process.env.POSITIONS_READ_KEY || "",
    });
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : "Server error" });
  }
};
