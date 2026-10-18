// 구역 분석 (12_zone_tobe/tobe_map.html을 옮긴 것, 10월 17일)
// 전과 다른 점: geojson과 csv 파일을 읽지 않고 시트에서 mapData 한 번으로 구역과 업장을 모두 받는다.
// 그래서 로컬 서버가 필요 없고, 구역을 다시 그리거나 현장에서 상태를 바꾸면 새로고침만으로 따라온다.

const STATIONS = [
  { name: "동대문역사문화공원역", lat: 37.56566, lng: 127.00900 },
  { name: "동대문역", lat: 37.57167, lng: 127.01063 },
  { name: "동묘앞역", lat: 37.57322, lng: 127.01636 },
  { name: "신설동역", lat: 37.57603, lng: 127.02446 },
];
const VIEWS = { all: [37.5712, 127.0165, 5], ddm: [37.5690, 127.0092, 4], sin: [37.5752, 127.0245, 3] };
// 구역 색은 데이터가 아니라 화면 설정이라 여기에 둔다 (시트 zones 탭에는 색 칸이 없다)
const ZONE_COLOR = {
  D1: "#4363d8", D2: "#f032e6", D3: "#e6194b", D4: "#9a6324", S1: "#1f3a5f",
};
// 구역으로 나누지 않고 업장 표시로만 구분하는 묶음. 세모 세 가지 색 (10월 18일 2차 재구성)
const TAG_CLASS = { "감성 맛집": "tg1", "오래된 로컬": "tg2", "풍물시장 푸드코트": "tg3" };
const TAG_COLOR = { "감성 맛집": "#e6007e", "오래된 로컬": "#6b3e00", "풍물시장 푸드코트": "#c9a100" };
// 현장 지도(field.js)와 같은 진행상태 색과 매핑
const STATUS_ORDER = ["미조사", "완료", "관리", "재방문", "제외"];
const STATUS_COLOR = { "미조사": "#e8590c", "완료": "#2b8a3e", "관리": "#1864ab", "재방문": "#c2255c", "제외": "#868e96" };
const SHEET_TO_APP = { "미방문": "미조사", "관측완료": "완료", "상담완료": "완료", "재방문필요": "재방문", "제외": "제외" };
const BEES_COLOR = "#f1c40f";
const GRAY = "#8a8f98";

const $ = id => document.getElementById(id);
const isChecked = v => v === true || String(v).toUpperCase() === "TRUE";
// 관리 체크가 켜져 있으면 제외가 아닌 한 관리로 센다 (현장 지도와 같은 규칙)
const appStatus = p => {
  const base = SHEET_TO_APP[p["진행상태"]];
  return isChecked(p["관리"]) && base !== "제외" ? "관리" : base;
};

let ZONES = [], zoneById = {}, zoneFeatures = [], places = [], fetchedAt = "";
let mode = "zones", map = null, homed = false, bubble = null;
const layers = { polys: [], labels: [], dots: [], marks: [] };

function fail(html) {
  $("error").style.display = "block";
  $("error").innerHTML = html;
}

/* ---------------- 지도 ---------------- */

function setView(key) {
  const [lat, lng, level] = VIEWS[key];
  map.relayout();
  map.setLevel(level);
  map.setCenter(new kakao.maps.LatLng(lat, lng));
}

function initMap() {
  map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(VIEWS.all[0], VIEWS.all[1]), level: VIEWS.all[2] });
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  // 창이 가려진 채 열리면 지도 크기가 0으로 잡혀 위치가 어긋난다. 크기가 정해지면 처음 화면으로 맞춘다
  new ResizeObserver(() => {
    if (!homed && $("map").clientWidth) { setView("all"); homed = true; } else map.relayout();
  }).observe($("map"));
  STATIONS.forEach(s => new kakao.maps.CustomOverlay({
    map, position: new kakao.maps.LatLng(s.lat, s.lng), yAnchor: 1.6, zIndex: 6,
    content: `<div class="station">${esc(s.name)}</div>`,
  }));
  kakao.maps.event.addListener(map, "click", closeBubble);
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function zoneOf(p) {
  const f = zoneFeatures.find(f => inRing(+p.lng, +p.lat, f.ring));
  return f ? f.zone_id : "";
}
// 태그는 구역과 따로다. 점 바깥에 세모를 둘러 구분한다
const tagClass = p => (p._tag && TAG_CLASS[p._tag] ? " tg " + TAG_CLASS[p._tag] : "");

/* ---------------- 말풍선 ---------------- */

function closeBubble() { if (bubble) { bubble.setMap(null); bubble = null; } }

function showInfo(p) {
  closeBubble();
  const el = document.createElement("div");
  el.className = "bubble";
  el.innerHTML = `<div class="b-head">Information<button class="b-x" aria-label="닫기">✕</button></div>
    업소명: ${esc(p["상호명"])}<br>
    카카오맵 기준 업태: ${esc(p["카카오 업종"] || "")}<br>
    주소: ${esc(p["주소"] || "")}`;
  el.querySelector(".b-x").onclick = e => { e.stopPropagation(); closeBubble(); };
  bubble = new kakao.maps.CustomOverlay({
    map, position: new kakao.maps.LatLng(+p.lat, +p.lng), content: el, yAnchor: 1, zIndex: 20, clickable: true,
  });
}

/* ---------------- 그리기 ---------------- */

function clear(key) { layers[key].forEach(o => o.setMap(null)); layers[key] = []; }

function drawPolygons(colored) {
  clear("polys");
  zoneFeatures.forEach(f => {
    const c = colored ? (ZONE_COLOR[f.zone_id] || GRAY) : GRAY;
    layers.polys.push(new kakao.maps.Polygon({
      map, path: f.ring.map(([x, y]) => new kakao.maps.LatLng(y, x)),
      strokeWeight: colored ? 3 : 2, strokeColor: c, strokeOpacity: 0.95,
      fillColor: c, fillOpacity: colored ? 0.25 : 0.12,
    }));
  });
}

// 이름은 그 구역 업장들의 가운데(중앙값)에 단다. 업장이 없으면 폴리곤 꼭짓점 평균. S3, S4는 폴리곤이 없어 달지 않는다
function drawLabels(list, colored) {
  clear("labels");
  ZONES.forEach(z => {
    const mine = list.filter(p => p._zone === z.zone_id);
    let x, y;
    if (mine.length) {
      const med = a => a.sort((m, n) => m - n)[Math.floor(a.length / 2)];
      x = med(mine.map(p => +p.lng));
      y = med(mine.map(p => +p.lat));
    } else {
      const f = zoneFeatures.find(f => f.zone_id === z.zone_id);
      if (!f) return;
      x = f.ring.reduce((a, p) => a + p[0], 0) / f.ring.length;
      y = f.ring.reduce((a, p) => a + p[1], 0) / f.ring.length;
    }
    const c = colored ? (ZONE_COLOR[z.zone_id] || "#555") : "#555";
    layers.labels.push(new kakao.maps.CustomOverlay({
      map, position: new kakao.maps.LatLng(y, x), zIndex: 7,
      content: `<div class="zlabel" style="border-color:${c};color:${c}">${esc(z["구역명"])}</div>`,
    }));
  });
}

function renderZones() {
  clear("dots"); clear("marks");
  drawPolygons(true);
  const counts = {};
  places.forEach(p => {
    p._zone = zoneOf(p);
    counts[p._zone] = (counts[p._zone] || 0) + 1;
    const el = document.createElement("div");
    el.className = "dot" + (p._zone ? "" : " none") + tagClass(p);
    if (p._zone) el.style.background = ZONE_COLOR[p._zone] || GRAY;
    el.onclick = () => showInfo(p);
    layers.dots.push(new kakao.maps.CustomOverlay({
      map, clickable: true, content: el, zIndex: 4, position: new kakao.maps.LatLng(+p.lat, +p.lng),
    }));
  });
  drawLabels(places, true);
  $("legend").innerHTML = ZONES.filter(z => counts[z.zone_id]).map(z =>
    `<div><span class="chip" style="background:${ZONE_COLOR[z.zone_id] || GRAY}"></span> ${esc(z["구역명"])} <b>${counts[z.zone_id]}</b></div>`
  ).join("") + `<div>${counts[""] ? `<span class="chip" style="background:#bbb"></span> 기타 <b>${counts[""]}</b>` : ""}</div>`
    + tagLegend() + stamp();
}

function renderSurvey() {
  clear("dots"); clear("marks");
  drawPolygons(false);
  const counts = {};
  places.forEach(p => {
    p._zone = zoneOf(p);
    const st = appStatus(p);
    counts[st] = (counts[st] || 0) + 1;
    const bees = isChecked(p["BEES"]);
    const el = document.createElement("div");
    el.className = "mk" + (bees ? " bees" : "") + tagClass(p);
    el.style.background = bees && st === "미조사" ? BEES_COLOR : STATUS_COLOR[st];
    el.onclick = () => showInfo(p);
    layers.marks.push(new kakao.maps.CustomOverlay({
      map, clickable: true, content: el, zIndex: 4, position: new kakao.maps.LatLng(+p.lat, +p.lng),
    }));
  });
  drawLabels(places, false);
  const bees = places.filter(p => isChecked(p["BEES"]));
  const beesN = s => bees.filter(p => appStatus(p) === s).length;
  const dash = `border:2px dashed #1f3a5f;width:12px;height:12px`;
  $("counts").innerHTML = STATUS_ORDER.map(s => `<span><i style="background:${STATUS_COLOR[s]}"></i>${s} <b>${counts[s] || 0}</b></span>`).join("")
    + `<span><i style="background:${BEES_COLOR};${dash}"></i>Bees 미조사 <b>${beesN("미조사")}</b></span>`
    + `<span><i style="background:${STATUS_COLOR["관리"]};${dash}"></i>Bees 관리 <b>${beesN("관리")}</b></span>`;
  $("legend").innerHTML = STATUS_ORDER.map(s => `<div><span class="lg-dot" style="background:${STATUS_COLOR[s]}"></span> ${s}</div>`).join("")
    + `<div><span class="lg-dot" style="background:${BEES_COLOR};border:2px dashed #1f3a5f"></span> Bees 미조사</div>`
    + `<div><span class="lg-dot" style="background:${STATUS_COLOR["관리"]};border:2px dashed #1f3a5f"></span> Bees 관리</div>`
    + tagLegend() + stamp();
}

// 태그 범례. 세모 세 가지 색
function tagLegend() {
  return Object.keys(TAG_COLOR).map(t => {
    const n = places.filter(p => p._tag === t).length;
    const tri = `<svg class="lg-tri" viewBox="0 0 100 100"><polygon points="50,6 95,94 5,94" fill="none" `
      + `stroke="${TAG_COLOR[t]}" stroke-width="9" stroke-linejoin="round"/></svg>`;
    return n ? `<div>${tri} ${esc(t)} <b>${n}</b></div>` : "";
  }).join("");
}

const stamp = () => `<div style="margin-top:4px;color:#666">시트 기준 ${esc(fetchedAt)} · ${places.length}곳</div>`;

function setMode(m) {
  mode = m;
  closeBubble();
  document.body.classList.toggle("survey", m === "survey");
  document.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  m === "zones" ? renderZones() : renderSurvey();
}

/* ---------------- 데이터 ---------------- */

// 시트 zones 탭의 경계는 MultiPolygon 문자열이다. 조각마다 바깥 고리 하나씩 꺼낸다
function parseFeatures(zones) {
  const out = [];
  zones.forEach(z => {
    let g;
    try { g = JSON.parse(z["경계"]); } catch (e) { return; }
    if (!g || g.type !== "MultiPolygon") return;
    g.coordinates.forEach(poly => out.push({ zone_id: z.zone_id, ring: poly[0] }));
  });
  return out;
}

async function load() {
  const body = await Api.call("mapData");
  const data = body.data || {};
  fetchedAt = body.fetchedAt || "";
  ZONES = (data.zones || []).filter(z => z.zone_id);
  zoneById = Object.fromEntries(ZONES.map(z => [z.zone_id, z]));
  zoneFeatures = parseFeatures(ZONES);
  // 좌표가 있고 진행상태를 아는 업장만 본다. 삭제는 조사 대상이 아니라 빠진다 (현장 지도와 같은 규칙)
  places = (data.places || [])
    .filter(p => p.lat !== "" && p.lat !== null && p.lng !== "" && p.lng !== null && SHEET_TO_APP[p["진행상태"]])
    .map(p => ({ ...p, _tag: p["TOBE 태그"] || "" }));
  if (!ZONES.length) fail("시트 zones 탭에 TOBE 구역이 없습니다");
  setMode(mode);
}

async function start() {
  const s = Store.settings();
  if (!s.url || !s.token || !s.kakao) {
    return fail('설정이 비어 있습니다. <a href="field.html">현장 모드</a>에서 Apps Script URL과 토큰, 카카오 JS 키를 먼저 넣으세요. '
      + "같은 기기에 저장되므로 한 번만 넣으면 됩니다.");
  }
  try {
    await loadKakao(s.kakao);
  } catch (err) {
    return fail(esc(err.message) + " 카카오 JS 키에 이 주소의 도메인이 등록되어 있어야 합니다.");
  }
  initMap();
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  $("reload").onclick = async () => {
    $("reload").disabled = true;
    try { await load(); $("error").style.display = "none"; }
    catch (err) { fail(esc(err.message)); }
    finally { $("reload").disabled = false; }
  };
  try {
    await load();
  } catch (err) {
    fail(esc(err.message));
  }
}

start();
