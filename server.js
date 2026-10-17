/* سرور اتاق: جایگزین Firebase. هم صفحه‌ها رو سرو می‌کنه هم WebSocket (/ws) برای چت، اتاق‌ها و سیگنال تماس.
   اجرا:  npm install && npm start      (پورت از متغیر PORT، پیش‌فرض 3000)
   متغیرهای اختیاری:
     DATA_FILE    مسیر فایل ذخیره‌ی داده (پیش‌فرض ./data/db.json) — روی هاست‌های ابری یه دیسک/volume بهش وصل کن تا بعد از ری‌استارت پاک نشه
     ICE_SERVERS  آرایه‌ی JSON سرورهای STUN/TURN برای تماس، مثلاً
                  [{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]  */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "db.json");
let ICE = null;
try{ if(process.env.ICE_SERVERS) ICE = JSON.parse(process.env.ICE_SERVERS); }catch(e){ console.error("ICE_SERVERS معتبر نیست"); }

const ROOM_RE = /^[A-Z0-9]{4,8}$/, SEG_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ROOM_KEYS = new Set(["meta", "profiles", "presence", "chat", "react", "video", "genre", "buf", "typing", "read", "history", "call"]);
const PERSIST = ["meta", "profiles", "chat", "video", "genre", "history", "read"];   // بقیه موقتیه و ذخیره نمی‌شه
const MAX_ROOMS = 2000, MAX_CHAT = 500, MAX_HIST = 100, MAX_VALUE = 40000, MAX_CONN = 400;

/* ---------- درخت داده ---------- */
let root = {};
try{ root = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) || {}; console.log("داده بارگذاری شد:", Object.keys(root.rooms || {}).length, "اتاق"); }catch(e){}
const isObj = v => v && typeof v === "object";
const getAt = segs => { let n = root; for(const s of segs){ if(!isObj(n) || !(s in n)) return null; n = n[s]; } return n === undefined ? null : n; };
function setAt(segs, v){
  if(!segs.length){ root = isObj(v) ? v : {}; return; }
  const chain = [root];
  for(let i = 0; i < segs.length - 1; i++){
    let n = chain[i][segs[i]];
    if(!isObj(n)){ if(v === null) return; n = chain[i][segs[i]] = {}; }
    chain.push(n);
  }
  const last = segs[segs.length - 1];
  if(v === null) delete chain[chain.length - 1][last]; else chain[chain.length - 1][last] = v;
  for(let i = chain.length - 1; i > 0; i--) if(!Object.keys(chain[i]).length) delete chain[i - 1][segs[i - 1]]; else break;
}
function resolveSV(v){
  if(Array.isArray(v)) return v.map(resolveSV);
  if(isObj(v)){
    if(v[".sv"] === "timestamp") return Date.now();
    const o = {}; for(const k of Object.keys(v)){ const r = resolveSV(v[k]); if(r !== null && r !== undefined) o[k] = r; } return o;
  }
  return v === undefined ? null : v;
}

/* ---------- ذخیره ---------- */
let dirty = false;
function persist(){
  if(!dirty) return; dirty = false;
  const out = { rooms: {} };
  for(const [c, r] of Object.entries(root.rooms || {})){ const o = {}; for(const k of PERSIST) if(r[k] !== undefined) o[k] = r[k]; out.rooms[c] = o; }
  try{ fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(out)); fs.renameSync(DATA_FILE + ".tmp", DATA_FILE); }
  catch(e){ console.error("ذخیره نشد:", e.message); dirty = true; }
}
setInterval(persist, 3000);
for(const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { persist(); process.exit(0); });

/* ---------- قوانین ---------- */
function parsePath(p){
  if(typeof p !== "string") return null;
  const segs = p.split("/").filter(Boolean);
  if(segs.length < 2 || segs.length > 8 || segs[0] !== "rooms" || !ROOM_RE.test(segs[1])) return null;
  return segs.every(s => SEG_RE.test(s)) ? segs : null;
}
function checkWrite(segs, v){
  if(segs.length === 2) return v === null ? null : "فقط حذف اتاق مجازه";
  const room = segs[1], sub = segs[2];
  if(!ROOM_KEYS.has(sub)) return "مسیر نامعتبر";
  const exists = isObj(getAt(["rooms", room, "meta"]));
  if(sub === "meta"){
    if(segs.length !== 3 || exists || v === null) return exists ? "اتاق از قبل هست" : "meta نامعتبر";
    if(!isObj(v) || Object.keys(v).join() !== "created") return "meta نامعتبر";
    if(Object.keys(root.rooms || {}).length >= MAX_ROOMS) return "ظرفیت سرور پره";
    return null;
  }
  if(!exists) return "اتاق وجود نداره";
  if(v !== null && JSON.stringify(v).length > MAX_VALUE) return "داده خیلی بزرگه";
  return null;
}

/* ---------- اشتراک‌ها و ارسال ---------- */
const clients = new Set();
const overlaps = (a, b) => { const n = Math.min(a.length, b.length); for(let i = 0; i < n; i++) if(a[i] !== b[i]) return false; return true; };
function valueFor(s){
  let v = getAt(s.segs);
  if(s.limit && isObj(v)){ const ks = Object.keys(v).sort().slice(-s.limit), o = {}; for(const k of ks) o[k] = v[k]; v = o; }
  return v;
}
function pushSub(c, s, force){
  const v = valueFor(s), j = JSON.stringify(v === undefined ? null : v);
  if(!force && j === s.last) return; s.last = j;
  send(c, { t: "snap", sid: s.sid, v });
}
const send = (c, m) => { if(c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
function write(segs, v){
  setAt(segs, v); dirty = true;
  const room = segs[1], sub = segs[2];
  if(sub === "chat") trim(["rooms", room, "chat"], MAX_CHAT);
  if(sub === "history") trim(["rooms", room, "history"], MAX_HIST);
  for(const c of clients) for(const s of c.subs.values()) if(overlaps(segs, s.segs)) pushSub(c, s);
}
function trim(segs, max){
  const n = getAt(segs); if(!isObj(n)) return;
  const ks = Object.keys(n); if(ks.length <= max) return;
  ks.sort().slice(0, ks.length - max).forEach(k => delete n[k]);
}

/* ---------- HTTP (فایل‌های سایت) ---------- */
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"], "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"], "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/icon-192.png": ["icon-192.png", "image/png"], "/icon-512.png": ["icon-512.png", "image/png"], "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"]
};
const server = http.createServer((req, res) => {
  const u = (req.url || "/").split("?")[0];
  if(u === "/healthz"){ res.writeHead(200); res.end("ok"); return; }
  const f = FILES[u];
  if(!f){ res.writeHead(404); res.end("not found"); return; }
  fs.readFile(path.join(__dirname, f[0]), (e, d) => {
    if(e){ res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": f[1], "Cache-Control": "no-cache" }); res.end(d);
  });
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 100 * 1024 });
wss.on("connection", ws => {
  if(clients.size >= MAX_CONN){ ws.close(1013); return; }
  const c = { ws, subs: new Map(), odr: new Set(), tokens: 60, alive: true };
  clients.add(c);
  send(c, { t: "hello", now: Date.now(), ice: ICE });
  const refill = setInterval(() => { c.tokens = Math.min(60, c.tokens + 30); }, 1000);
  ws.on("pong", () => { c.alive = true; });
  ws.on("message", raw => {
    if(--c.tokens < 0) return;
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }
    const ack = (err, v) => m.id && send(c, { t: "ack", id: m.id, err: err || undefined, v });
    switch(m.op){
      case "ping": send(c, { t: "pong" }); break;
      case "sub": {
        const segs = parsePath(m.path); if(!segs) return;
        const s = { sid: m.sid, segs, limit: Math.min(Number(m.limit) || 0, 200), last: null };
        c.subs.set(m.sid, s); pushSub(c, s, true); break;
      }
      case "unsub": c.subs.delete(m.sid); break;
      case "get": {
        const segs = parsePath(m.path); if(!segs) return ack("PERMISSION_DENIED");
        ack(null, getAt(segs)); break;
      }
      case "set": {
        const segs = parsePath(m.path); if(!segs) return ack("PERMISSION_DENIED");
        const v = m.v === undefined ? null : resolveSV(m.v), bad = checkWrite(segs, v);
        if(bad) return ack("PERMISSION_DENIED: " + bad);
        write(segs, v); ack(null); break;
      }
      case "odr": { const segs = parsePath(m.path); if(segs && c.odr.size < 50) c.odr.add(segs.join("/")); break; }
    }
  });
  ws.on("close", () => {
    clearInterval(refill); clients.delete(c);
    for(const p of c.odr){ const segs = p.split("/"); if(getAt(segs) !== null) write(segs, null); }
  });
  ws.on("error", () => {});
});
setInterval(() => { for(const c of clients){ if(!c.alive){ c.ws.terminate(); continue; } c.alive = false; try{ c.ws.ping(); }catch(e){} } }, 30000);

server.listen(PORT, () => console.log("سرور روی پورت", PORT, "آماده‌ست"));
