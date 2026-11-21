// 냉장고 확인 화면 (11월 20일)
// 조사 대상 곳에서 냉장고만 보고 "현재 취급 NAB"를 한 번에 기록한다. 상태(완료)는 건드리지 않는다. 나중에 일괄로 올린다.
// 여기서 저장한 값은 "현장 확인 시점"의 취급 현황이다. 활동 전 기록은 기존 조사 기록(nabSeen)으로 따로 있고 화면에 참고로만 보여 준다.
// 입구에서 보이는 입간판(L1)과 다국어 메뉴판(L2)은 보았을 때만 켠다. 켜지 않은 것은 없음이 아니라 비워 둔다.
// POCM(매장 안팎의 주류 홍보물)은 경쟁사(테라, 테라 제로)와 우리(카스)를 각각 있음, 없음으로 기록한다. 안 골랐으면 비워 둔다.
// 저장은 시트 "외국인지원" 탭에 saveSupport로 쓰고, 통신이 끊겨도 전송 대기열에 보관했다가 다시 보낸다.

const STATIONS = [
  { name: "동대문역사문화공원역", lat: 37.56566, lng: 127.00900 },
  { name: "동대문역", lat: 37.57167, lng: 127.01063 },
  { name: "동묘앞역", lat: 37.57322, lng: 127.01636 },
  { name: "신설동역", lat: 37.57603, lng: 127.02446 },
];
const NAB_LIST = ["카스 0.0", "카스 레몬 0.0", "테라 제로", "하이트 제로", "기타"];
const POCM = [{ key: "경쟁사 POCM", d: "pr", label: "경쟁사 POCM", sub: "테라, 테라 제로" }, { key: "우리 POCM", d: "po", label: "우리 POCM", sub: "카스" }];
const REVISIT = ["영업 전", "브레이크 타임", "사장님 부재", "냉장고 안 보임"];
const KIND_LABEL = { todo: "미확인", prior: "기록 있음", again: "재방문", done: "확인" };
const KIND_COLOR = { todo: "#e8590c", prior: "#0b7285", again: "#c2255c", done: "#2b8a3e" };
const QUEUE_KEY = "cet.fridge.queue";

const $ = id => document.getElementById(id);
const fixturePath = () => new URLSearchParams(location.search).get("fixture");
const text = v => (v === null || v === undefined ? "" : String(v).trim());
const splitList = v => text(v).split(",").map(s => s.trim()).filter(Boolean);
const nowStr = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

let map = null, homed = false, me = null, meOverlay = null;
let ZONES = [], features = [], places = [], byId = {}, rows = {}, seg = {}, nabSeen = {};
const marks = {};
const layers = { zones: [], labels: [] };
let selId = null, draft = null, queue = [], flushing = false;

let toastTimer = null;
function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("on"), 3000);
}
const fail = html => { $("error").style.display = "block"; $("error").innerHTML = html; };
const hideFail = () => { $("error").style.display = "none"; };
function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = x => (x * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------------- 상태 ---------------- */

const nabOf = id => text((rows[id] || {})["현재 취급 NAB"]);
// 현장에서 값이 저장된 곳이 확인, 재방문으로 남긴 곳, 기존 기록이 있는 곳(후순위), 나머지가 미확인
function kindOf(id) {
  const r = rows[id];
  if (!r) return "";
  if (nabOf(id)) return "done";
  if (text(r["상태"]) === "재방문") return "again";
  if (nabSeen[id] && nabSeen[id].length) return "prior";
  return "todo";
}
const rival = list => (!list.length ? "" : list.some(x => x === "테라 제로" || x === "하이트 제로" || x === "기타") ? "있음" : "없음");

/* ---------------- 지도 ---------------- */

function initMap() {
  map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(37.5712, 127.0125), level: 4 });
  new ResizeObserver(() => { if (!homed && $("map").clientWidth) { fitTargets(); homed = true; } else map.relayout(); }).observe($("map"));
  STATIONS.forEach(s => new kakao.maps.CustomOverlay({
    map, position: new kakao.maps.LatLng(s.lat, s.lng), yAnchor: 1.7, zIndex: 3,
    content: `<div class="zlabel" style="background:#222;color:#fff">${esc(s.name)}</div>`,
  }));
  kakao.maps.event.addListener(map, "click", () => { closeHits(); });
  window.addEventListener("resize", () => map.relayout());
  setTimeout(() => map.relayout(), 600);
}

function fitTargets() {
  const ids = Object.keys(rows).filter(id => byId[id]);
  if (!ids.length) return;
  const b = new kakao.maps.LatLngBounds();
  ids.forEach(id => b.extend(new kakao.maps.LatLng(byId[id].lat, byId[id].lng)));
  map.relayout();
  map.setBounds(b, 90, 30, 30, 30);
}

function parseFeatures(zones) {
  const out = [];
  zones.forEach(z => {
    let g; try { g = JSON.parse(z["경계"]); } catch (e) { return; }
    if (!g || g.type !== "MultiPolygon") return;
    g.coordinates.forEach(poly => out.push({ zone_id: z.zone_id, ring: poly[0] }));
  });
  return out;
}

function drawZones() {
  layers.zones.forEach(o => o.setMap(null)); layers.labels.forEach(o => o.setMap(null));
  layers.zones = []; layers.labels = [];
  features.forEach(f => layers.zones.push(new kakao.maps.Polygon({
    map, path: f.ring.map(([x, y]) => new kakao.maps.LatLng(y, x)), strokeWeight: 2, strokeColor: "#8a8f98", strokeOpacity: .8, fillColor: "#8a8f98", fillOpacity: 0.03,
  })));
  ZONES.forEach(z => {
    const f = features.filter(x => x.zone_id === z.zone_id).flatMap(x => x.ring);
    if (!f.length) return;
    const x = f.reduce((a, p) => a + p[0], 0) / f.length, y = f.reduce((a, p) => a + p[1], 0) / f.length;
    layers.labels.push(new kakao.maps.CustomOverlay({ map, position: new kakao.maps.LatLng(y, x), zIndex: 1, content: `<div class="zlabel">${esc(z.zone_id)}</div>` }));
  });
}

const markClass = id => "mk t " + (kindOf(id) || "g") + (selId === id ? " sel" : "");

function buildMarks() {
  Object.keys(marks).forEach(id => { marks[id].overlay.setMap(null); delete marks[id]; });
  Object.keys(rows).forEach(id => { if (byId[id]) addMark(byId[id]); });
}
function addMark(p) {
  const el = document.createElement("div");
  el.className = markClass(p.id);
  el.onclick = e => { e.stopPropagation(); openSheet(p.id); };
  marks[p.id] = { el, overlay: new kakao.maps.CustomOverlay({ map, clickable: true, content: el, position: new kakao.maps.LatLng(p.lat, p.lng), zIndex: 6 }) };
}
function paintMark(id) {
  if (!marks[id]) return;
  marks[id].el.className = markClass(id);
  marks[id].overlay.setZIndex(selId === id ? 9 : 6);
}

function counts() {
  const c = { todo: 0, prior: 0, again: 0, done: 0 };
  Object.keys(rows).forEach(id => { c[kindOf(id)]++; });
  return c;
}
function renderCounts() {
  const c = counts(), total = Object.keys(rows).length;
  $("counts").innerHTML = `<button class="cnt goal${c.done === total ? " ok" : ""}" data-list="전체">확인 <b>${c.done}</b> / ${total}</button>`
    + ["todo", "prior", "again"].map(k => `<button class="cnt" data-list="${k}"><i style="background:${KIND_COLOR[k]}"></i>${KIND_LABEL[k]} <b>${c[k]}</b></button>`).join("");
  $("counts").querySelectorAll("[data-list]").forEach(b => b.onclick = () => openList(b.dataset.list));
}

/* ---------------- 검색, 목록 ---------------- */

const norm = s => text(s).replace(/\s+/g, "").toLowerCase();
function closeHits() { $("hits").hidden = true; }
function search() {
  const q = norm($("q").value);
  if (!q) return closeHits();
  const hit = Object.keys(rows).map(id => byId[id]).filter(p => p && norm(p.name).includes(q)).slice(0, 8);
  $("hits").innerHTML = hit.length
    ? hit.map(p => `<button data-id="${esc(p.id)}">${esc(p.name)}<small>${esc(p.zone || "구역 밖")} ${esc(KIND_LABEL[kindOf(p.id)])}</small></button>`).join("")
    : `<button disabled>조사 대상 중에 일치하는 곳이 없습니다</button>`;
  $("hits").hidden = false;
  $("hits").querySelectorAll("[data-id]").forEach(b => b.onclick = () => { closeHits(); $("q").value = ""; goTo(b.dataset.id); });
}

function origin() { return me || (map ? { lat: map.getCenter().getLat(), lng: map.getCenter().getLng() } : { lat: 37.5712, lng: 127.0125 }); }

let listFilter = "todo";
function openList(filter) {
  listFilter = filter === "전체" ? "전체" : (filter || "todo");
  renderList();
  $("listPanel").hidden = false;
  closeSheet();
}
function renderList() {
  const o = origin(), c = counts();
  const all = Object.keys(rows).filter(id => byId[id]).map(id => ({ p: byId[id], k: kindOf(id), d: distanceM(o.lat, o.lng, byId[id].lat, byId[id].lng) }));
  const list = all.filter(x => listFilter === "전체" || x.k === listFilter).sort((a, b) => a.d - b.d);
  const fbtn = ["todo", "prior", "again", "done", "전체"].map(f => `<button class="b sm${listFilter === f ? " on" : ""}" data-f="${f}">${f === "전체" ? "전체 " + all.length : KIND_LABEL[f] + " " + c[f]}</button>`).join("");
  $("listPanel").innerHTML = `<div class="stick"><div class="s-head"><div><h3>${listFilter === "전체" ? "전체" : KIND_LABEL[listFilter]} ${list.length}곳</h3><p class="muted">${me ? "내 위치" : "지도 가운데"}에서 가까운 순</p></div><button class="x" data-a="closeList">✕</button></div><div class="chips">${fbtn}</div></div>`
    + (list.length ? list.map(({ p, k, d }) => `<button class="li" data-id="${esc(p.id)}"><i style="background:${KIND_COLOR[k]}"></i>
        <span class="nm">${esc(p.name)}<small>${esc(p.zone || "구역 밖")} ${esc(seg[p.id] ? seg[p.id].lv3 : "")}${nabOf(p.id) ? " / " + esc(nabOf(p.id)) : ""}</small></span><span class="ds">${d < 1000 ? Math.round(d) + "m" : (d / 1000).toFixed(1) + "km"}</span></button>`).join("")
      : `<p class="muted" style="margin-top:14px">해당하는 곳이 없습니다</p>`);
  const panel = $("listPanel");
  panel.querySelector("[data-a=closeList]").onclick = () => { panel.hidden = true; };
  panel.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { listFilter = b.dataset.f; renderList(); panel.scrollTop = 0; });
  panel.querySelectorAll("[data-id]").forEach(b => b.onclick = () => { panel.hidden = true; goTo(b.dataset.id); });
}

function locate() {
  if (!navigator.geolocation) return toast("이 기기에서는 위치를 쓸 수 없습니다");
  navigator.geolocation.getCurrentPosition(pos => {
    me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const at = new kakao.maps.LatLng(me.lat, me.lng);
    if (!meOverlay) meOverlay = new kakao.maps.CustomOverlay({ map, position: at, content: `<div class="me"></div>`, zIndex: 10 });
    else meOverlay.setPosition(at);
    map.setLevel(3); map.setCenter(at);
  }, () => toast("위치 권한이 없습니다. 브라우저 설정에서 위치를 허용하세요"), { enableHighAccuracy: true, timeout: 15000 });
}
function goTo(id) {
  const p = byId[id];
  if (!p) return;
  if (map.getLevel() > 3) map.setLevel(3);
  map.setCenter(new kakao.maps.LatLng(p.lat, p.lng));
  openSheet(id);
}

/* ---------------- 시트 ---------------- */

function openSheet(id) {
  selId = id;
  const r = rows[id] || {};
  draft = { nab: splitList(r["현재 취급 NAB"]), l1: !!text(r["L1 입간판"]), l2: !!text(r["L2 메뉴판"]), pr: text(r["경쟁사 POCM"]), po: text(r["우리 POCM"]), startedAt: nowStr() };
  Object.keys(marks).forEach(paintMark);
  renderSheet();
  $("sheet").hidden = false; $("listPanel").hidden = true;
  const p = byId[id];
  if (p && map && window.innerWidth < 760) { map.setCenter(new kakao.maps.LatLng(p.lat, p.lng)); map.panBy(0, Math.round(window.innerHeight * 0.22)); }
}
function closeSheet() {
  const old = selId; selId = null; draft = null; $("sheet").hidden = true;
  if (old) paintMark(old);
}

function renderSheet() {
  const id = selId, p = byId[id], r = rows[id] || {}, g = seg[id] || {}, d = draft, k = kindOf(id);
  const keep = $("sheet").scrollTop;
  const tags = [];
  if (text(r["층"]) === "P1") tags.push(`<span class="tag act">사입 완료 곳 (지금 상태는 활동 후)</span>`);
  if (k === "done") tags.push(`<span class="tag act">확인됨</span>`);
  if (k === "again") tags.push(`<span class="tag" style="background:#fde2ec;color:#a61e4d">재방문 ${esc(text(r["재방문 사유"]))}</span>`);
  const prior = nabSeen[id] || [];
  let html = `<div class="s-head"><div><h3>${esc(p.name)}</h3><p class="muted">${esc([p.zone || "구역 밖", g.lv3].filter(Boolean).join("  /  "))}</p>${tags.length ? `<div class="fr-tags">${tags.join("")}</div>` : ""}</div><button class="x" data-a="close">✕</button></div>`;
  if (prior.length) html += `<div class="fr-prior">기존 조사 기록: ${esc(prior.join(", "))}<br>지금 냉장고와 달라도 그대로 기록하세요. 이 기록은 활동 전 자료로 따로 보관됩니다.</div>`;
  const pocmChanged = pocmDiff(r);
  html += `<h4>냉장고에서 본 NAB <small>여러 개 선택 가능</small></h4>
    <div class="chips fr-chips">${NAB_LIST.map(v => `<button class="b${d.nab.includes(v) ? " on" : ""}" data-a="nab" data-v="${esc(v)}">${esc(v)}</button>`).join("")}</div>
    <h4>POCM <small>안 골랐으면 비워 둡니다</small></h4>
    ${POCM.map(x => `<div class="fr-row"><span class="lbl">${esc(x.label)}<small>${esc(x.sub)}</small></span>
      <button class="b${d[x.d] === "있음" ? " on" : ""}" data-a="${x.d}" data-v="있음">있음</button>
      <button class="b${d[x.d] === "없음" ? " on" : ""}" data-a="${x.d}" data-v="없음">없음</button></div>`).join("")}
    <h4>입구에서 보였다면 켜세요 <small>안 켠 것은 없음이 아니라 비워 둡니다</small></h4>
    <div class="chips">
      <button class="b${d.l1 ? " on" : ""}${text(r["L1 입간판"]) ? " lock" : ""}" data-a="l1">입간판 있음${text(r["L1 입간판"]) ? " (기존 자료)" : ""}</button>
      <button class="b${d.l2 ? " on" : ""}${text(r["L2 메뉴판"]) ? " lock" : ""}" data-a="l2">다국어 메뉴판 있음${text(r["L2 메뉴판"]) ? " (기존 자료)" : ""}</button>
    </div>
    <button class="fr-big ok" data-a="saveNab"${d.nab.filter(x => x !== "없음").length ? "" : " disabled"}>${d.nab.filter(x => x !== "없음").length ? "저장 (" + esc(d.nab.join(", ")) + ")" : "NAB를 골라 주세요"}</button>
    <button class="fr-big none" data-a="saveNone">냉장고에 NAB 없음, 바로 저장</button>`;
  if (pocmChanged) html += `<div class="fr-small"><button class="b" data-a="savePocm">POCM만 저장 (냉장고는 나중에)</button></div>`;
  if (k !== "done") {
    html += `<h4>냉장고를 못 봤나요?</h4><div class="chips">${REVISIT.map(v => `<button class="b" data-a="revisit" data-v="${esc(v)}">${esc(v)}</button>`).join("")}</div>`;
  } else {
    html += `<div class="fr-small"><button class="b" data-a="clear">확인값 지우기</button></div>`;
  }
  $("sheet").innerHTML = html;
  $("sheet").scrollTop = keep;
}

function onSheetClick(e) {
  const t = e.target.closest("[data-a]");
  if (!t || !draft) return;
  const a = t.dataset.a, v = t.dataset.v;
  switch (a) {
    case "close": return closeSheet();
    case "nab": { const i = draft.nab.indexOf(v); i >= 0 ? draft.nab.splice(i, 1) : draft.nab.push(v); draft.nab = draft.nab.filter(x => x !== "없음"); break; }
    case "pr": case "po": draft[a] = draft[a] === v ? "" : v; break;
    case "l1": if (!text((rows[selId] || {})["L1 입간판"])) draft.l1 = !draft.l1; break;
    case "l2": if (!text((rows[selId] || {})["L2 메뉴판"])) draft.l2 = !draft.l2; break;
    case "saveNab": return commit(draft.nab.filter(x => x !== "없음"));
    case "saveNone": return commit(["없음"]);
    case "savePocm": return commitPocm();
    case "revisit": return commitRevisit(v);
    case "clear": return commitClear();
    default: return;
  }
  renderSheet();
}

/* ---------------- 저장 ---------------- */

// L1, L2는 보았을 때만 쓰고, 이미 값이 있는 칸은 덮어쓰지 않는다
function levelPart(item, r) {
  if (draft.l1 && !text(r["L1 입간판"])) item["L1 입간판"] = "원래";
  if (draft.l2 && !text(r["L2 메뉴판"])) item["L2 메뉴판"] = "원래";
}
// 화면에서 바꾼 POCM만 보낸다. 기존 값을 비우면 빈 값으로 지운다
function pocmDiff(r) { return POCM.some(x => text(draft[x.d]) !== text(r[x.key])); }
function pocmPart(item, r) {
  POCM.forEach(x => { if (text(draft[x.d]) !== text(r[x.key])) item[x.key] = draft[x.d]; });
}
function commit(list) {
  const id = selId, r = rows[id] || {};
  const item = { place_id: id, "시작 시각": draft.startedAt, "현재 취급 NAB": list.join(", "), "경쟁 제로": rival(list) };
  levelPart(item, r); pocmPart(item, r);
  push(item, `${byId[id].name} 저장 (${item["현재 취급 NAB"]})`);
}
function commitRevisit(reason) {
  const id = selId, item = { place_id: id, "시작 시각": draft.startedAt, "상태": "재방문", "재방문 사유": reason };
  pocmPart(item, rows[id] || {});
  push(item, `${byId[id].name} 재방문으로 저장`);
}
function commitPocm() {
  const id = selId, item = { place_id: id, "시작 시각": draft.startedAt };
  pocmPart(item, rows[id] || {});
  push(item, `${byId[id].name} POCM 저장`);
}
function commitClear() {
  const id = selId;
  push({ place_id: id, "현재 취급 NAB": "", "경쟁 제로": "" }, `${byId[id].name} 확인값을 지웠습니다`);
}
function push(item, msg) {
  const id = item.place_id;
  rows[id] = Object.assign({}, rows[id] || { place_id: id, "상호명": byId[id].name, "구역": byId[id].zone }, item);
  queue.push(item); persistQueue(); renderQueue();
  closeSheet(); paintMark(id); renderCounts();
  toast(msg);
  flush();
}

function persistQueue() { Store.set(QUEUE_KEY, JSON.stringify(queue)); }
function renderQueue() {
  const el = $("queue");
  el.hidden = !queue.length;
  el.textContent = `전송 대기 ${queue.length}건 (누르면 다시 보냄)`;
}
async function send(item) {
  if (fixturePath()) { (window.__saved = window.__saved || []).push(item); await new Promise(r => setTimeout(r, 120)); return; }
  await Api.call("saveSupport", { items: [item] });
}
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      try { await send(queue[0]); queue.shift(); persistQueue(); renderQueue(); }
      catch (err) {
        if (err.network || err.retryable) { toast("통신이 불안정합니다. 입력은 보관되어 있고 나중에 다시 보냅니다"); break; }
        const bad = queue.shift(); persistQueue(); renderQueue();
        toast(`저장이 거부되었습니다 (${(byId[bad.place_id] || {}).name}). ${err.message}`);
        try { await load(); } catch (e2) { /* 다음에 새로고침한다 */ }
      }
    }
  } finally { flushing = false; renderQueue(); }
}

/* ---------------- 데이터 ---------------- */

async function fetchData() {
  const fx = fixturePath();
  if (fx) return await (await fetch(fx)).json();
  return Api.call("supportMap");
}
async function load() {
  const body = await fetchData(), data = body.data || {};
  ZONES = (data.zones || []).filter(z => z.zone_id);
  features = parseFeatures(ZONES);
  places = data.places || [];
  byId = Object.fromEntries(places.map(p => [p.id, p]));
  seg = data.seg || {};
  nabSeen = data.nabSeen || {};
  rows = {};
  (data.rows || []).forEach(r => { if (text(r.place_id)) rows[text(r.place_id)] = r; });
  // 아직 서버에 못 보낸 입력은 화면에 다시 얹는다
  queue.forEach(it => { if (byId[it.place_id]) rows[it.place_id] = Object.assign({}, rows[it.place_id] || { place_id: it.place_id }, it); });
  hideFail();
  drawZones(); buildMarks(); renderCounts();
  if (!Object.keys(rows).length) fail('조사 대상이 비어 있습니다. 시트 "외국인지원" 탭을 확인하세요.');
}

async function start() {
  const s = Store.settings();
  if ((!fixturePath() && (!s.url || !s.token)) || !s.kakao) {
    return fail('설정이 비어 있습니다. <a href="field.html">현장 모드</a>에서 Apps Script URL과 토큰, 카카오 JS 키를 먼저 넣으세요. 같은 기기에 저장되므로 한 번만 넣으면 됩니다.');
  }
  try { await loadKakao(s.kakao); } catch (err) { return fail(esc(err.message) + " 카카오 JS 키에 이 주소의 도메인이 등록되어 있어야 합니다."); }
  try { queue = JSON.parse(Store.get(QUEUE_KEY) || "[]"); } catch (e) { queue = []; }
  initMap();
  $("sheet").addEventListener("click", onSheetClick);
  $("q").addEventListener("input", search);
  $("fit").onclick = () => { closeSheet(); fitTargets(); };
  $("locate").onclick = locate;
  $("listBtn").onclick = () => openList("todo");
  $("queue").onclick = flush;
  window.addEventListener("online", flush);
  try { await load(); renderQueue(); flush(); } catch (err) { fail(esc(err.message)); }
}

start();
