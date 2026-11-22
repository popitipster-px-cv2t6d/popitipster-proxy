// POPITIPSTER proxy: solo sirve lo que la app muestra. La clave vive en variables de entorno.
const http = require("http"), https = require("https");
const KEY = process.env.BSD_KEY || "", APP = process.env.APP_TOKEN || "";
const HOST = "sports.bzzoiro.com";
const OK_ORIGIN = /^(null|file:\/\/|https:\/\/popitipster-app\.surge\.sh)$/;
const num = "\\d{1,9}";
const ROUTES = [
  { re: new RegExp("^/api/v2/predictions/\\?limit=(\\d{1,3})&offset=(\\d{1,5})$"), ttl: 300 },
  { re: new RegExp("^/api/v2/events/" + num + "/(odds|stats)/$"), ttl: 300 },
  { re: new RegExp("^/api/v2/events/\\?team_id=" + num + "&status=finished&limit=\\d{1,3}$"), ttl: 600 },
  { re: new RegExp("^/api/v2/events/\\?league_id=" + num + "&status=finished&limit=\\d{1,3}$"), ttl: 600 },
  { re: new RegExp("^/api/v2/teams/" + num + "/squad/$"), ttl: 1800 },
  { re: new RegExp("^/api/v2/players/" + num + "/stats/\\?league_id=\\d{0,9}(&[a-z_]+=[A-Za-z0-9_.-]{0,20})*$"), ttl: 1800 },
  { re: new RegExp("^/basketball/api/v2/events/\\?league=2&status=(finished|scheduled)&date_from=[0-9-]{10}(&date_to=[0-9-]{10})?&limit=\\d{1,3}(&offset=\\d{1,4})?$"), ttl: 600 },
  { re: new RegExp("^/basketball/api/v2/predictions/\\?league=2&limit=\\d{1,3}$"), ttl: 600 },
  { re: new RegExp("^/basketball/api/v2/standings/\\?league=2$"), ttl: 1800 },
  { re: new RegExp("^/img/team/" + num + "/$"), ttl: 86400, img: true }
];
const cache = new Map(); // url -> {t, code, type, body}
const hits = new Map();  // ip -> [count, windowStart]
function cors(res, origin) {
  if (OK_ORIGIN.test(origin || "null")) res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "X-Popi");
  res.setHeader("Vary", "Origin");
}
function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ "Content-Type": type, "Cache-Control": "no-store" }, extra || {}));
  res.end(body);
}
function upstream(path, img) {
  return new Promise((ok, ko) => {
    const h = { "User-Agent": "POPITIPSTER-proxy/1.0", Accept: img ? "image/*" : "application/json" };
    if (!img) h.Authorization = "Token " + KEY;
    const rq = https.request({ host: HOST, path, method: "GET", headers: h, timeout: 12000 }, (r) => {
      const ch = []; r.on("data", (c) => ch.push(c));
      r.on("end", () => ok({ code: r.statusCode, type: r.headers["content-type"] || "application/json", body: Buffer.concat(ch) }));
    });
    rq.on("timeout", () => rq.destroy(new Error("timeout")));
    rq.on("error", ko); rq.end();
  });
}
http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  cors(res, origin);
  if (req.method === "OPTIONS") return send(res, 204, "text/plain", "");
  if (req.url === "/health") return send(res, 200, "text/plain", "ok");
  if (req.method !== "GET") return send(res, 405, "text/plain", "no");
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now(), e = hits.get(ip) || [0, now];
  if (now - e[1] > 60000) { e[0] = 0; e[1] = now; }
  if (++e[0] > 120) { hits.set(ip, e); return send(res, 429, "text/plain", "demasiadas peticiones"); }
  hits.set(ip, e); if (hits.size > 5000) hits.clear();
  const route = ROUTES.find((r) => r.re.test(req.url));
  if (!route) return send(res, 404, "text/plain", "no");
  if (!route.img && (!APP || req.headers["x-popi"] !== APP)) return send(res, 403, "text/plain", "no");
  if (!route.img && req.headers.origin && !OK_ORIGIN.test(req.headers.origin)) return send(res, 403, "text/plain", "no");
  const c = cache.get(req.url);
  if (c && now - c.t < route.ttl * 1000) return send(res, c.code, c.type, c.body, { "X-Cache": "HIT", "Cache-Control": route.img ? "public, max-age=86400" : "no-store" });
  try {
    const u = await upstream(req.url, route.img);
    if (u.code === 200) { if (cache.size > 800) cache.clear(); cache.set(req.url, { t: now, code: 200, type: u.type, body: u.body }); }
    else if (c) return send(res, c.code, c.type, c.body, { "X-Cache": "STALE" });
    return send(res, u.code, u.type, u.body, { "X-Cache": "MISS", "Cache-Control": route.img ? "public, max-age=86400" : "no-store" });
  } catch (err) {
    if (c) return send(res, c.code, c.type, c.body, { "X-Cache": "STALE" });
    return send(res, 502, "text/plain", "upstream: " + err.message);
  }
}).listen(process.env.PORT || 3000);
