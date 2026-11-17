// 외국인 지원 조사 입력 화면 (11월 17일)
// 관측완료 150곳을 주황 "미조사"로 하이라이트하고, 나머지 모든 상호는 회색으로 깔아 둔다.
// 매장을 누르면 아래에서 시트가 올라온다. 1차원은 상태(조사 완료, 재방문, 제외), 완료를 고르면 2차원 준비 정도, 3차원 업주 니즈가 이어진다.
// 입력은 시트의 "외국인지원" 탭에 한 매장 한 행으로 쌓인다. places 진행상태는 건드리지 않는다.
// 통신이 끊겨도 입력이 사라지지 않도록 전송 대기열을 두고 다시 보낸다.

const STATIONS = [
  { name: "동대문역사문화공원역", lat: 37.56566, lng: 127.00900 },
  { name: "동대문역", lat: 37.57167, lng: 127.01063 },
  { name: "동묘앞역", lat: 37.57322, lng: 127.01636 },
  { name: "신설동역", lat: 37.57603, lng: 127.02446 },
];
const STATUS_CLASS = { "미조사": "todo", "완료": "done", "재방문": "again", "제외": "out" };
const STATUS_COLOR = { "미조사": "#e8590c", "완료": "#2b8a3e", "재방문": "#c2255c", "제외": "#868e96" };
const QUEUE_KEY = "cet.support.queue";

// 준비 정도 단계. 키는 시트 칸 이름과 같다
const LEVELS = [
  { col: "L1 입간판", n: 1, name: "L1 입간판", hint: "" },
  { col: "L2 메뉴판", n: 2, name: "L2 메뉴판", hint: "다국어" },
  { col: "L3 키오스크", n: 3, name: "L3 주문 키오스크", hint: "다국어" },
  { col: "L4 안내물", n: 4, name: "L4 오프라인 안내물", hint: "먹는 법, 메뉴 설명, 다국어 포스터와 배너와 테이블텐트" },
  { col: "L5 온라인", n: 5, name: "L5 온라인 연계", hint: "자체 홈페이지, 네이버와 구글 리뷰 연계" },
];
const LANGS = ["영", "일", "중", "기타"];
const EXCLUDE = [
  { group: "비대상", items: ["폐업 또는 휴업", "주류 미취급", "업태 무관", "중복 핀"] },
  { group: "소극", items: ["이미 담당자가 있음", "폐쇄적 또는 방어적", "업장이 너무 작음"] },
  { group: "그 밖", items: ["기타"] },
];
const REVISIT = ["사장님 부재", "브레이크 타임", "영업 전", "기타"];
const HELP = ["오프라인 메뉴판", "온라인 메뉴판", "키오스크 다국어화", "먹는 법 안내", "입간판 또는 외부 안내", "포스터와 배너와 테이블텐트", "외국어 리뷰 유도", "응대용 번역 문구", "기타"];
const DRINK = ["맥주", "소주", "전통주", "위스키 또는 하이볼", "와인", "기타"];
const SOJU = ["거의 없다", "절반 미만", "절반 이상", "대부분"];
const NAB = ["자주", "가끔", "없음"];
const RIVAL = ["있음", "없음"];
const ACT = ["적극", "보통", "소극"];
const FINAL = ["한맥", "NAB", "후순위"];

const $ = id => document.getElementById(id);
const fixturePath = () => new URLSearchParams(location.search).get("fixture");

let map = null, homed = false, me = null, meOverlay = null;
let ZONES = [], features = [], places = [], byId = {}, rows = {}, seg = {}, fetchedAt = "";
const marks = {};
let selId = null, draft = null, queue = [], flushing = false;
const layers = { zones: [], labels: [] };

/* ---------------- 도우미 ---------------- */

const text = v => (v === null || v === undefined ? "" : String(v).trim());
const splitList = v => text(v).split(",").map(s => s.trim()).filter(Boolean);
const nowStr = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
let toastTimer = null;
function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("on"), 3200);
}
const fail = html => { $("error").style.display = "block"; $("error").innerHTML = html; };
const hideFail = () => { $("error").style.display = "none"; };
function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = x => (x * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const statusOf = id => (rows[id] ? text(rows[id]["상태"]) || "미조사" : "");
// 숫자칩과 목록은 조사 대상(150곳과 현장에서 더한 곳) 기준이다. 명단 밖 업장을 제외로 기록한 것은 세지 않고 지도에 ✕로만 남긴다
const counted = id => !!rows[id] && !(text(rows[id]["층"]) === "추가" && statusOf(id) === "제외");

/* ---------------- 지도 ---------------- */

function initMap() {
  map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(37.5712, 127.0125), level: 4 });
  new ResizeObserver(() => { if (!homed && $("map").clientWidth) { fitTargets(); homed = true; } else map.relayout(); }).observe($("map"));
  STATIONS.forEach(s => new kakao.maps.CustomOverlay({
    map, position: new kakao.maps.LatLng(s.lat, s.lng), yAnchor: 1.7, zIndex: 3,
    content: `<div class="zlabel" style="background:#222;color:#fff">${esc(s.name)}</div>`,
  }));
  kakao.maps.event.addListener(map, "click", () => { closeHits(); });
  kakao.maps.event.addListener(map, "rightclick", e => openPinSheet(e.latLng.getLat(), e.latLng.getLng()));
  initLongPress();
  // 화면 크기가 바뀌면(회전, 주소창 접힘) 지도를 다시 맞춘다
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
    layers.labels.push(new kakao.maps.CustomOverlay({ map, position: new kakao.maps.LatLng(y, x), zIndex: 1,
      content: `<div class="zlabel">${esc(z.zone_id)}</div>` }));
  });
}

/* ---------------- 마커 ---------------- */

function markClass(id) {
  const st = statusOf(id);
  return "mk " + (st ? "t " + STATUS_CLASS[st] : "g") + (selId === id ? " sel" : "");
}

function buildMarks() {
  Object.keys(marks).forEach(id => { marks[id].overlay.setMap(null); delete marks[id]; });
  places.forEach(p => addMark(p));
}

function addMark(p) {
  const el = document.createElement("div");
  el.className = markClass(p.id);
  el.onclick = e => { e.stopPropagation(); openSheet(p.id); };
  const overlay = new kakao.maps.CustomOverlay({ map, clickable: true, content: el, position: new kakao.maps.LatLng(p.lat, p.lng), zIndex: rows[p.id] ? 6 : 2 });
  marks[p.id] = { overlay, el };
}

function paintMark(id) {
  if (!marks[id]) return;
  marks[id].el.className = markClass(id);
  marks[id].overlay.setZIndex(selId === id ? 9 : rows[id] ? 6 : 2);
}

function renderCounts() {
  const c = { "미조사": 0, "완료": 0, "재방문": 0, "제외": 0 };
  Object.keys(rows).filter(counted).forEach(id => { c[statusOf(id)] = (c[statusOf(id)] || 0) + 1; });
  $("counts").innerHTML = Object.keys(c).map(s => `<button class="cnt" data-list="${s}"><i style="background:${STATUS_COLOR[s]}"></i>${s} <b>${c[s]}</b></button>`).join("");
  $("counts").querySelectorAll("[data-list]").forEach(b => b.onclick = () => openList(b.dataset.list));
}

/* ---------------- 검색, 목록, 내 위치 ---------------- */

const norm = s => text(s).replace(/\s+/g, "").toLowerCase();
function closeHits() { $("hits").hidden = true; }
function search() {
  const q = norm($("q").value);
  if (!q) return closeHits();
  const hit = places.filter(p => norm(p.name).includes(q)).slice(0, 8);
  $("hits").innerHTML = hit.length
    ? hit.map(p => `<button data-id="${esc(p.id)}">${esc(p.name)}<small>${esc(p.zone || "구역 밖")} ${esc(statusOf(p.id) || "")}</small></button>`).join("")
    : `<button disabled>일치하는 업장이 없습니다</button>`;
  $("hits").hidden = false;
  $("hits").querySelectorAll("[data-id]").forEach(b => b.onclick = () => { closeHits(); $("q").value = ""; goTo(b.dataset.id); });
}

function origin() { return me || (map ? { lat: map.getCenter().getLat(), lng: map.getCenter().getLng() } : { lat: 37.5712, lng: 127.0125 }); }

let listFilter = "전체", listSort = "거리";
function openList(filter) {
  if (filter) listFilter = filter;
  renderList();
  $("listPanel").hidden = false;
  closeSheet();
}

// 조사 대상 전체를 한눈에 본다. 상태별로 걸러 보고 가까운 순이나 구역별로 정렬한다
function renderList() {
  const o = origin();
  const all = Object.keys(rows).filter(id => byId[id] && counted(id)).map(id => ({ p: byId[id], st: statusOf(id), d: distanceM(o.lat, o.lng, byId[id].lat, byId[id].lng) }));
  const n = { "전체": all.length };
  Object.keys(STATUS_COLOR).forEach(s => { n[s] = all.filter(x => x.st === s).length; });
  const list = all.filter(x => listFilter === "전체" || x.st === listFilter);
  list.sort(listSort === "구역"
    ? (a, b) => (a.p.zone || "ZZ").localeCompare(b.p.zone || "ZZ") || a.p.name.localeCompare(b.p.name)
    : (a, b) => a.d - b.d);
  const from = me ? "내 위치" : "지도 가운데";
  const fbtn = ["전체", ...Object.keys(STATUS_COLOR)].map(f => `<button class="b sm${listFilter === f ? " on" : ""}" data-f="${f}">${f} ${n[f]}</button>`).join("");
  const sbtn = ["거리", "구역"].map(s => `<button class="b sm${listSort === s ? " on" : ""}" data-s="${s}">${s === "거리" ? "가까운 순" : "구역별"}</button>`).join("");
  $("listPanel").innerHTML = `<div class="stick"><div class="s-head"><div><h3>${listFilter === "전체" ? "조사 대상" : esc(listFilter)} ${list.length}곳</h3><p class="muted">${listSort === "거리" ? from + "에서 가까운 순" : "구역별"}</p></div><button class="x" data-a="closeList">✕</button></div>
      <div class="chips">${fbtn}</div><div class="chips" style="margin-top:6px">${sbtn}</div></div>`
    + (list.length ? list.map(({ p, st, d }) => `<button class="li" data-id="${esc(p.id)}"><i style="background:${STATUS_COLOR[st]}"></i>
        <span class="nm">${esc(p.name)}<small>${esc(p.zone || "구역 밖")} ${esc(seg[p.id] ? seg[p.id].lv3 : "")}${listFilter === "전체" ? " / " + st : ""}</small></span><span class="ds">${d < 1000 ? Math.round(d) + "m" : (d / 1000).toFixed(1) + "km"}</span></button>`).join("")
      : `<p class="muted" style="margin-top:14px">해당하는 곳이 없습니다</p>`);
  const panel = $("listPanel");
  panel.querySelector("[data-a=closeList]").onclick = () => { panel.hidden = true; };
  panel.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { listFilter = b.dataset.f; renderList(); panel.scrollTop = 0; });
  panel.querySelectorAll("[data-s]").forEach(b => b.onclick = () => { listSort = b.dataset.s; renderList(); panel.scrollTop = 0; });
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

/* ---------------- 임의 핀(새 업장) ---------------- */

function initLongPress() {
  const el = $("map");
  let timer = null, x0 = 0, y0 = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return cancel();
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; cancel();
    timer = setTimeout(() => {
      timer = null;
      const r = el.getBoundingClientRect();
      const ll = map.getProjection().coordsFromContainerPoint(new kakao.maps.Point(x0 - r.left, y0 - r.top));
      if (navigator.vibrate) navigator.vibrate(30);
      openPinSheet(ll.getLat(), ll.getLng());
    }, 650);
  }, { passive: true });
  el.addEventListener("touchmove", e => { const t = e.touches[0]; if (timer && t && Math.hypot(t.clientX - x0, t.clientY - y0) > 12) cancel(); }, { passive: true });
  el.addEventListener("touchend", cancel); el.addEventListener("touchcancel", cancel);
}

function openPinSheet(lat, lng) {
  $("pinSheet").innerHTML = `<div class="s-head"><h3>새 업장 추가</h3><button class="x" id="pinX">✕</button></div>
    <label class="in">상호명<input id="pinName" type="text" autocomplete="off" placeholder="간판에 적힌 이름"></label>
    <div class="row2" style="margin-top:14px"><button class="b" id="pinCancel">취소</button><button class="b on" id="pinOk">추가</button></div>`;
  $("pinSheet").hidden = false;
  const close = () => { $("pinSheet").hidden = true; };
  $("pinX").onclick = close; $("pinCancel").onclick = close;
  $("pinOk").onclick = async () => {
    const name = $("pinName").value.trim();
    if (!name) return toast("상호명을 입력하세요");
    close();
    try {
      let place;
      if (fixturePath()) place = { place_id: "TMP" + Date.now(), "상호명": name, lat, lng, zone_id: "" };
      else place = (await Api.call("addPlace", { name, lat, lng })).place;
      const p = { id: text(place.place_id), name: text(place["상호명"]), zone: text(place.zone_id), lat: Number(place.lat), lng: Number(place.lng), addr: "" };
      if (!byId[p.id]) { places.push(p); byId[p.id] = p; addMark(p); }
      toast(`${name} 추가 완료`);
      openSheet(p.id);
    } catch (err) { toast(`추가하지 못했습니다. ${err.message}`); }
  };
  setTimeout(() => $("pinName").focus(), 50);
}

/* ---------------- 시트: 초안 ---------------- */

// 시트 값 "원래:영,일" 같은 문자열을 { orig, ours, langs, set }으로 푼다. 빈 값과 "없음"은 모두 체크 없음으로 시작한다
function parseLevel(v) {
  const s = text(v), out = { orig: false, ours: false, langs: [] };
  if (!s || s === "없음") return out;
  const [kind, langs] = s.split(":");
  out.orig = kind.includes("원래"); out.ours = kind.includes("설치");
  out.langs = splitList(langs);
  return out;
}
function levelValue(l) {
  if (!l.orig && !l.ours) return "없음";
  const kind = l.orig && l.ours ? "원래+설치" : l.orig ? "원래" : "설치";
  return kind + (l.langs.length ? ":" + l.langs.join(",") : "");
}

function makeDraft(id) {
  const r = rows[id] || {}, g = seg[id] || {};
  const st = text(r["상태"]);
  return {
    status: st && st !== "미조사" ? st : "",
    excl: text(r["제외 사유"]), memo: text(r["메모"]), rvReason: text(r["재방문 사유"]), rvTime: text(r["재방문 시각"]),
    L: LEVELS.map(lv => parseLevel(r[lv.col])),
    act: text(r["적극성"]), help: splitList(r["희망 지원"]), helpTop: text(r["가장 원하는 지원"]),
    drink: text(r["1순위 주류"]), soju: text(r["소주 비중"]), nab: text(r["NAB 수요"]),
    rival: text(r["경쟁 제로"]) || (g.rivalZero ? "있음" : ""),
    final: text(r["최종 추천"]), why: text(r["추천 사유"]),
    startedAt: nowStr(),
  };
}

// ASIS는 원래 있던 것만, TOBE는 우리가 설치한 것까지 합친 가장 높은 단계
const stageOf = (d, key) => d.L.reduce((hi, l, i) => ((key === "orig" ? l.orig : l.orig || l.ours) ? i + 1 : hi), 0);
// L1 이상이 있으면 보통, L2 이상이면 적극으로 본다(개입 전 상태 기준). L0이면 업주에게 직접 묻는다
function derivedAct(d) { const a = stageOf(d, "orig"); return a >= 2 ? "적극" : a >= 1 ? "보통" : ""; }
const actOf = d => derivedAct(d) || d.act;

function recommend(d) {
  const nab = d.nab === "자주" || d.nab === "가끔", sojuHeavy = d.soju === "절반 이상" || d.soju === "대부분";
  if (!d.nab || !d.soju) return null;
  if (nab) return { rec: "NAB", note: d.rival === "있음" ? "NAB 수요가 있고 경쟁 제로가 있어 LS 0.0(레몬)부터" : d.rival === "없음" ? "NAB 수요가 있고 경쟁 제로가 없어 CASS 0.0부터" : "NAB 수요가 있습니다. 경쟁 제로 여부를 확인하세요" };
  if (sojuHeavy) return { rec: "후순위", note: "소주 비중이 절반 이상이라 한맥 제안의 우선순위를 낮춥니다" };
  return { rec: "한맥", note: "기본 추천(Korean Lager)" };
}

/* ---------------- 시트: 그리기 ---------------- */

const bt = (a, v, cur, extra = "") => `<button class="b${cur ? " on" : ""}" data-a="${a}" data-v="${esc(v)}" ${extra}>${esc(v)}</button>`;
const chips = (a, list, isOn) => `<div class="chips">${list.map(v => bt(a, v, isOn(v))).join("")}</div>`;

function openSheet(id) {
  selId = id; draft = makeDraft(id);
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
  const p = byId[selId], g = seg[selId] || {}, d = draft;
  const keep = $("sheet").scrollTop;
  const info = [p.zone || "구역 밖", g.lv3, g.brands && g.brands.length ? "취급 " + g.brands.join(", ") : ""].filter(Boolean).join("  /  ");
  let html = `<div class="s-head"><div><h3>${esc(p.name)}${rows[selId] ? "" : `<span class="tag">명단 밖</span>`}</h3><p class="muted">${esc(info)}</p></div><button class="x" data-a="close">✕</button></div>
    <div class="st-row">${["완료", "재방문", "제외"].map(s => `<button class="st${d.status === s ? " on" : ""}" data-a="status" data-v="${s}" style="--c:${STATUS_COLOR[s]}">${s === "완료" ? "조사 완료" : s}</button>`).join("")}</div>`;
  if (d.status === "제외") html += excludePanel(d);
  else if (d.status === "재방문") html += revisitPanel(d);
  else if (d.status === "완료") html += donePanel(d, g);
  else html += `<p class="muted">상태를 고르면 입력 칸이 열립니다</p>`;
  $("sheet").innerHTML = html;
  $("sheet").scrollTop = keep;
  const bind = (id, key) => { if ($(id)) $(id).oninput = e => { draft[key] = e.target.value; }; };
  bind("memo", "memo"); bind("rvTime", "rvTime"); bind("why", "why");
}

function excludePanel(d) {
  return EXCLUDE.map(g => `<div class="grp"><b>${esc(g.group)}</b>${chips("excl", g.items, v => d.excl === v)}</div>`).join("")
    + `<label class="in">메모${d.excl === "기타" ? " (기타는 꼭 적어 주세요)" : ""}<textarea id="memo" placeholder="사유를 짧게">${esc(d.memo)}</textarea></label>
       <button class="save out" data-a="save">제외로 저장</button>`;
}

function revisitPanel(d) {
  return `<h4>재방문 사유</h4>${chips("rvr", REVISIT, v => d.rvReason === v)}
    <label class="in">다시 올 시각 (들은 경우만)<input id="rvTime" type="text" placeholder="예: 16:00" value="${esc(d.rvTime)}" autocomplete="off"></label>
    <label class="in">메모<textarea id="memo" placeholder="선택">${esc(d.memo)}</textarea></label>
    <button class="save again" data-a="save">재방문으로 저장</button>`;
}

function levelRow(d, i) {
  const lv = LEVELS[i], l = d.L[i], on = l.orig || l.ours;
  return `<div class="lv"><div class="nm">${esc(lv.name)}${lv.hint ? `<small>${esc(lv.hint)}</small>` : ""}</div>
    <div class="tg"><button class="b${l.orig ? " on" : ""}" data-a="lvo" data-i="${i}">원래 있음</button><button class="b${l.ours ? " on" : ""}" data-a="lvs" data-i="${i}">우리 설치</button></div>
    ${on ? `<div class="lg"><span>언어</span>${LANGS.map(x => `<button class="b${l.langs.includes(x) ? " on" : ""}" data-a="lang" data-i="${i}" data-v="${x}">${x}</button>`).join("")}</div>` : ""}</div>`;
}

function donePanel(d, g) {
  const asis = stageOf(d, "orig"), tobe = stageOf(d, "all"), auto = derivedAct(d), act = actOf(d);
  let html = `<h4>1 준비 정도 <small>켠 것만 있음으로 기록됩니다. 아무것도 없으면 그대로 두세요</small></h4>`;
  html += LEVELS.map((_, i) => levelRow(d, i)).join("");
  html += `<div class="badge">개입 전 L${asis}${tobe !== asis ? `, 설치 후 L${tobe}` : ""}</div>`;

  html += `<h4>2 업주 니즈</h4>`;
  if (auto) html += `<div class="badge">적극성 ${auto} (준비 정도로 자동 판정)</div>`;
  else html += `<div class="grp"><b>외국인 준비에 대한 적극성</b>${chips("act", ACT, v => d.act === v)}</div>`;
  html += `<div class="grp"><b>가장 많이 나가는 주류</b>${chips("drink", DRINK, v => d.drink === v)}</div>
    <div class="grp"><b>소주 비중</b><div class="seg">${SOJU.map(v => bt("soju", v, d.soju === v)).join("")}</div></div>`;
  if (act === "소극") {
    html += `<div class="rec none">소극으로 기록합니다. 희망 지원과 제품 추천은 묻지 않습니다</div>`;
  } else {
    html += `<div class="grp"><b>희망하는 지원 <small>여러 개 선택, 별표는 가장 원하는 1개</small></b><div class="chips">${HELP.map(v => {
      const on = d.help.includes(v);
      return `<span style="display:inline-flex;gap:4px">${bt("help", v, on)}${on ? `<button class="b star${d.helpTop === v ? " on" : ""}" data-a="top" data-v="${esc(v)}" aria-label="가장 원하는 1개">★</button>` : ""}</span>`;
    }).join("")}</div></div>
    <div class="grp"><b>NAB 수요 <small>논알콜 문의나 주문을 받은 적</small></b><div class="seg">${NAB.map(v => bt("nab", v, d.nab === v)).join("")}</div></div>
    <div class="grp"><b>경쟁 제로 취급${g.rivalZero ? " <small>(명단 기준 있음)</small>" : ""}</b><div class="seg">${RIVAL.map(v => bt("rival", v, d.rival === v)).join("")}</div></div>`;
    const r = recommend(d);
    html += r ? `<div class="rec">규칙 추천 <b>${r.rec}</b><br>${esc(r.note)}</div>
      <div class="grp"><b>최종 추천</b><div class="seg">${FINAL.map(v => bt("final", v, (d.final || r.rec) === v)).join("")}</div></div>
      ${(d.final && d.final !== r.rec) ? `<label class="in">추천을 바꾼 사유<input id="why" type="text" value="${esc(d.why)}" placeholder="한 줄" autocomplete="off"></label>` : ""}`
      : `<div class="rec none">소주 비중과 NAB 수요를 고르면 추천이 자동으로 나옵니다</div>`;
  }
  html += `<label class="in">메모<textarea id="memo" placeholder="선택">${esc(d.memo)}</textarea></label>
    <button class="save" data-a="save">완료로 저장</button>`;
  return html;
}

/* ---------------- 시트: 동작 ---------------- */

function toggle(arr, v) { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); }

function onSheetClick(e) {
  const t = e.target.closest("[data-a]");
  if (!t || !draft) return;
  const a = t.dataset.a, v = t.dataset.v, i = Number(t.dataset.i);
  switch (a) {
    case "close": return closeSheet();
    case "status": draft.status = v; break;
    case "excl": draft.excl = v; break;
    case "rvr": draft.rvReason = v; break;
    case "lvo": draft.L[i].orig = !draft.L[i].orig; break;
    case "lvs": draft.L[i].ours = !draft.L[i].ours; break;
    case "lang": toggle(draft.L[i].langs, v); break;
    case "act": draft.act = v; break;
    case "drink": draft.drink = v; break;
    case "soju": draft.soju = v; break;
    case "help": toggle(draft.help, v); if (!draft.help.includes(v) && draft.helpTop === v) draft.helpTop = ""; break;
    case "top": draft.helpTop = draft.helpTop === v ? "" : v; break;
    case "nab": draft.nab = v; break;
    case "rival": draft.rival = v; break;
    case "final": draft.final = v; break;
    case "save": return save();
    default: return;
  }
  renderSheet();
}

// 저장할 칸. 키는 시트 칸 이름이다
function buildItem() {
  const d = draft, id = selId, item = { place_id: id, "시작 시각": d.startedAt };
  if (!rows[id]) item["층"] = "추가";
  if (d.status === "제외") {
    if (!d.excl) return { error: "제외 사유를 고르세요" };
    if (d.excl === "기타" && !d.memo.trim()) return { error: "기타는 메모를 적어 주세요" };
    return Object.assign(item, { "상태": "제외", "제외 사유": d.excl, "메모": d.memo.trim() });
  }
  if (d.status === "재방문") {
    if (!d.rvReason) return { error: "재방문 사유를 고르세요" };
    return Object.assign(item, { "상태": "재방문", "재방문 사유": d.rvReason, "재방문 시각": d.rvTime.trim(), "메모": d.memo.trim(), "제외 사유": "" });
  }
  if (d.status !== "완료") return { error: "상태를 고르세요" };
  const act = actOf(d), miss = [];
  if (!act) miss.push("적극성");
  if (!d.drink) miss.push("가장 많이 나가는 주류");
  if (!d.soju) miss.push("소주 비중");
  const rec = recommend(d);
  if (act && act !== "소극") { if (!d.nab) miss.push("NAB 수요"); if (!d.rival) miss.push("경쟁 제로"); }
  if (miss.length) return { error: miss.join(", ") + "을(를) 골라 주세요" };
  Object.assign(item, { "상태": "완료", "제외 사유": "", "재방문 사유": "", "재방문 시각": "", "메모": d.memo.trim(),
    "ASIS 단계": "L" + stageOf(d, "orig"), "TOBE 단계": "L" + stageOf(d, "all"), "적극성": act, "1순위 주류": d.drink, "소주 비중": d.soju });
  LEVELS.forEach((lv, i) => { item[lv.col] = levelValue(d.L[i]); });
  if (act === "소극") {
    Object.assign(item, { "희망 지원": "", "가장 원하는 지원": "", "NAB 수요": "", "경쟁 제로": "", "규칙 추천": "", "최종 추천": "", "추천 사유": "" });
  } else {
    const fin = d.final || (rec && rec.rec) || "";
    Object.assign(item, { "희망 지원": d.help.join(", "), "가장 원하는 지원": d.helpTop, "NAB 수요": d.nab, "경쟁 제로": d.rival,
      "규칙 추천": rec ? rec.rec : "", "최종 추천": fin, "추천 사유": rec && fin !== rec.rec ? d.why.trim() : "" });
  }
  return item;
}

function save() {
  const item = buildItem();
  if (item.error) return toast(item.error);
  const id = selId;
  applyLocal(item);
  queue.push(item); persistQueue(); renderQueue();
  toast(`${byId[id].name} 저장`);
  closeSheet();
  flush();
}

// 화면에 먼저 반영한다. 서버 응답을 기다리지 않아 현장에서 바로 다음 매장으로 넘어갈 수 있다
function applyLocal(item) {
  const id = item.place_id, p = byId[id];
  const cur = rows[id] || { place_id: id, "상호명": p.name, "구역": p.zone };
  rows[id] = Object.assign({}, cur, item);
  paintMark(id); renderCounts();
}

/* ---------------- 전송 대기열 ---------------- */

function persistQueue() { Store.set(QUEUE_KEY, JSON.stringify(queue)); }
function renderQueue() {
  const el = $("queue");
  el.hidden = !queue.length;
  el.textContent = `전송 대기 ${queue.length}건 (누르면 다시 보냄)`;
}

async function send(item) {
  if (fixturePath()) { (window.__saved = window.__saved || []).push(item); await new Promise(r => setTimeout(r, 150)); return; }
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
        // 서버가 값을 거부했다. 대기열에서 빼고 서버 기준으로 다시 그린다
        const bad = queue.shift(); persistQueue(); renderQueue();
        toast(`저장이 거부되었습니다 (${(byId[bad.place_id] || {}).name}). ${err.message}`);
        try { await load(); } catch (e2) { /* 다음에 새로고침한다 */ }
      }
    }
  } finally { flushing = false; renderQueue(); }
}

/* ---------------- 데이터 ---------------- */

function parseFeatures(zones) {
  const out = [];
  zones.forEach(z => {
    let g; try { g = JSON.parse(z["경계"]); } catch (e) { return; }
    if (!g || g.type !== "MultiPolygon") return;
    g.coordinates.forEach(poly => out.push({ zone_id: z.zone_id, ring: poly[0] }));
  });
  return out;
}

async function fetchData() {
  const fx = fixturePath();
  if (fx) return await (await fetch(fx)).json();
  return Api.call("supportMap");
}

async function load() {
  const body = await fetchData(), data = body.data || {};
  fetchedAt = body.fetchedAt || "";
  ZONES = (data.zones || []).filter(z => z.zone_id);
  features = parseFeatures(ZONES);
  places = data.places || [];
  byId = Object.fromEntries(places.map(p => [p.id, p]));
  seg = data.seg || {};
  rows = {};
  (data.rows || []).forEach(r => { if (text(r.place_id)) rows[text(r.place_id)] = r; });
  // 아직 서버에 못 보낸 입력은 화면에 다시 얹는다
  queue.forEach(it => { if (byId[it.place_id]) applyLocalSilent(it); });
  hideFail();
  drawZones(); buildMarks(); renderCounts();
  if (!Object.keys(rows).length) fail('조사 대상이 비어 있습니다. 시트 "외국인지원" 탭에 관측완료 150곳이 아직 들어가지 않았습니다.');
}
function applyLocalSilent(item) {
  const id = item.place_id, p = byId[id];
  rows[id] = Object.assign({}, rows[id] || { place_id: id, "상호명": p.name, "구역": p.zone }, item);
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
  $("listBtn").onclick = () => openList("전체");
  $("queue").onclick = flush;
  window.addEventListener("online", flush);
  try { await load(); renderQueue(); flush(); } catch (err) { fail(esc(err.message)); }
}

start();
