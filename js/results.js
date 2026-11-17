// 결과 정리 지도 (11월 17일)
// 구역 위에 KPI 사입 항목을 POC별로 보여 준다. 한 POC가 여러 항목을 사입하므로 마커를 항목 수만큼 나뉜 도넛으로 그리고,
// 가운데에 KPI Score를 적는다. 범례의 항목을 누르면 그 항목이 든 POC만 남는다.
// 데이터는 시트의 KPI 탭과 "KPI 정리" 탭에서 kpiMap 한 번으로 받는다. 정성 자료(인터뷰)가 공개 저장소에 올라가지 않도록
// 파일로 두지 않고 토큰이 있는 API로만 읽는다.

const STATIONS = [
  { name: "동대문역사문화공원역", lat: 37.56566, lng: 127.00900 },
  { name: "동대문역", lat: 37.57167, lng: 127.01063 },
  { name: "동묘앞역", lat: 37.57322, lng: 127.01636 },
  { name: "신설동역", lat: 37.57603, lng: 127.02446 },
];
const VIEWS = { all: [37.5712, 127.0165, 5], ddm: [37.5690, 127.0092, 4], sin: [37.5752, 127.0245, 3] };
// 구역 색은 데이터가 아니라 화면 설정이라 여기에 둔다 (구역 분석 화면과 같다)
const ZONE_COLOR = { D1: "#4363d8", D2: "#f032e6", D3: "#e6194b", D4: "#9a6324", S1: "#1f3a5f" };
const GRAY = "#8a8f98";

// 사입 항목과 색. 순서는 성수진이 준 순서이고 도넛 조각도 이 순서로 놓인다
// flags는 KPI 탭 열 이름이다. Bees는 10월과 11월을 한 색으로 묶고 상세에서 따로 보여 준다
const ITEMS = [
  { key: "Bottle Hanmac", color: "#43a047", ink: "#fff", flags: ["Bottle Hanmac"] },
  { key: "Bees", color: "#fb8c00", ink: "#222", flags: ["BEES 10월", "BEES 11월"] },
  { key: "Draft Hanmac", color: "#1b5e20", ink: "#fff", flags: ["Draft Hanmac"] },
  { key: "Draft Stella", color: "#e53935", ink: "#fff", flags: ["Draft Stella"] },
  { key: "NAB CASS 0.0", color: "#795548", ink: "#fff", flags: ["NAB CASS 0.0"] },
  { key: "NAB CASS LS 0.0", color: "#ffe600", ink: "#222", flags: ["NAB CASS LS 0.0"] },
  { key: "NAB Combo", color: "#b8860b", ink: "#fff", flags: ["NAB Combo"] },
  // 색을 정하지 않은 항목. 시트에 값이 생겼을 때만 범례에 나온다
  { key: "Draft Bud", color: "#546e7a", ink: "#fff", flags: ["Draft Bud"], optional: true },
];
const FLAG_ITEM = Object.fromEntries(ITEMS.flatMap(it => it.flags.map(f => [f, it])));
const FLAG_LABEL = { "BEES 10월": "Bees 10월", "BEES 11월": "Bees 11월" };

const $ = id => document.getElementById(id);

let map = null, homed = false;
let ZONES = [], zoneFeatures = [], pocs = [], unmatched = [], fetchedAt = "";
let selected = new Set();      // 켜진 항목. 비어 있으면 전체
let matchAll = false;          // true면 켜진 항목을 모두 가진 POC만
let zoneSel = "";              // 고른 구역. 비어 있으면 전체
let pocSel = null;             // 상세를 연 POC의 place_id
const layers = { polys: [], labels: [], marks: [] };

const clear = k => { layers[k].forEach(o => o.setMap(null)); layers[k] = []; };
const fail = (html, warn) => { $("error").className = warn ? "warn" : ""; $("error").style.display = "block"; $("error").innerHTML = html; };
const hideFail = () => { $("error").style.display = "none"; };
const isPhone = () => window.matchMedia("(max-width: 720px)").matches;
const itemsOf = p => ITEMS.filter(it => it.flags.some(f => p.flags[f]));
const zoneKey = p => p.zone_id || "";
const zoneName = id => (id ? `${id} ${(ZONES.find(z => z.zone_id === id) || {})["구역명"] || ""}`.trim() : "기타");
const plain = v => { const s = String(v || "").trim(); return s && s !== "-" ? s : ""; };

/* ---------------- 지도 ---------------- */

// 패널이 지도를 덮는 만큼. 지도 가운데를 보이는 쪽으로 옮기고 구역을 맞출 때 여백으로 쓴다
function covered() {
  const open = !$("side").classList.contains("off");
  return isPhone() ? { right: 0, bottom: open ? Math.round(innerHeight * 0.48) : 0 } : { right: open ? 360 : 0, bottom: 0 };
}

function setView(key) {
  const [lat, lng, level] = VIEWS[key];
  map.relayout();
  map.setLevel(isPhone() ? level + 1 : level);   // 폰은 화면이 좁아 한 단계 더 넓게
  map.setCenter(new kakao.maps.LatLng(lat, lng));
  const c = covered();
  if (c.right || c.bottom) map.panBy(c.right / 2, c.bottom / 2);
}

function initMap() {
  map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(VIEWS.all[0], VIEWS.all[1]), level: VIEWS.all[2] });
  // 오른쪽은 패널이 덮으므로 확대 축소 조절은 왼쪽에 둔다
  if (!isPhone()) map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.LEFT);
  // 창이 가려진 채 열리면 지도 크기가 0으로 잡혀 위치가 어긋난다. 크기가 정해지면 처음 화면으로 맞춘다
  new ResizeObserver(() => {
    if (!homed && $("map").clientWidth) { setView("all"); homed = true; } else map.relayout();
  }).observe($("map"));
  STATIONS.forEach(s => new kakao.maps.CustomOverlay({
    map, position: new kakao.maps.LatLng(s.lat, s.lng), yAnchor: 1.6, zIndex: 3,
    content: `<div class="station">${esc(s.name)}</div>`,
  }));
  kakao.maps.event.addListener(map, "click", () => { if (zoneSel) selectZone(""); });
}

/* ---------------- 도넛 마커 ---------------- */

// 항목 수만큼 같은 크기로 나눈 고리. 12시 방향에서 시계 방향으로 놓는다
function donut(its, score) {
  const S = 38, c = S / 2, R = 12.5, W = 8;
  const pt = a => [c + R * Math.cos(a), c + R * Math.sin(a)];
  let ring = "";
  if (!its.length) {
    ring = `<circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="#b9bec6" stroke-width="${W}"/>`;
  } else if (its.length === 1) {
    ring = `<circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="${its[0].color}" stroke-width="${W}"/>`;
  } else {
    const gap = 0.06;
    its.forEach((it, i) => {
      const a0 = -Math.PI / 2 + (i / its.length) * 2 * Math.PI + gap / 2;
      const a1 = -Math.PI / 2 + ((i + 1) / its.length) * 2 * Math.PI - gap / 2;
      const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
      ring += `<path d="M${x0.toFixed(2)} ${y0.toFixed(2)}A${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}" `
        + `fill="none" stroke="${it.color}" stroke-width="${W}"/>`;
    });
  }
  return `<svg viewBox="0 0 ${S} ${S}"><circle cx="${c}" cy="${c}" r="${c - 1}" fill="#fff" stroke="rgba(0,0,0,.35)" stroke-width="1"/>`
    + ring + `<circle cx="${c}" cy="${c}" r="${R - W / 2 - 0.5}" fill="#fff"/>`
    + `<text x="${c}" y="${c + 3.6}" text-anchor="middle" font-size="${score >= 100 ? 8 : 10}" font-weight="700" fill="#222">${score}</text></svg>`;
}

/* ---------------- 걸러내기 ---------------- */

const passItem = p => {
  if (!selected.size) return true;
  const have = new Set(itemsOf(p).map(it => it.key));
  const want = [...selected];
  return matchAll ? want.every(k => have.has(k)) : want.some(k => have.has(k));
};
const passZone = p => !zoneSel || zoneKey(p) === (zoneSel === "기타" ? "" : zoneSel);

/* ---------------- 집계 ---------------- */

// 구역 안 POC의 항목별 수. all이 true면 구역을 가리지 않고 전체
function zoneStats(zoneId, all) {
  const list = all ? pocs : pocs.filter(p => zoneKey(p) === zoneId);
  const counts = {};
  ITEMS.forEach(it => { counts[it.key] = list.filter(p => itemsOf(p).includes(it)).length; });
  return {
    list, counts,
    total: list.length,
    reached: list.filter(p => itemsOf(p).length).length,
    score: list.reduce((a, p) => a + p.score, 0),
  };
}

/* ---------------- 그리기 ---------------- */

function drawZones() {
  clear("polys"); clear("labels");
  zoneFeatures.forEach(f => {
    const c = ZONE_COLOR[f.zone_id] || GRAY;
    const on = zoneSel === f.zone_id;
    const poly = new kakao.maps.Polygon({
      map, path: f.ring.map(([x, y]) => new kakao.maps.LatLng(y, x)),
      strokeWeight: on ? 4 : 2.5, strokeColor: c, strokeOpacity: on ? 1 : .85,
      fillColor: c, fillOpacity: on ? .2 : zoneSel ? .04 : .1,
    });
    kakao.maps.event.addListener(poly, "click", () => selectZone(f.zone_id));
    layers.polys.push(poly);
  });
  // 이름표는 그 구역 POC의 가운데에 단다. POC가 없으면 폴리곤 꼭짓점 평균
  ZONES.forEach(z => {
    const mine = pocs.filter(p => p.zone_id === z.zone_id);
    let x, y;
    if (mine.length) {
      const med = a => a.sort((m, n) => m - n)[Math.floor(a.length / 2)];
      x = med(mine.map(p => p.lng)); y = med(mine.map(p => p.lat));
    } else {
      const f = zoneFeatures.find(f => f.zone_id === z.zone_id);
      if (!f) return;
      x = f.ring.reduce((a, p) => a + p[0], 0) / f.ring.length;
      y = f.ring.reduce((a, p) => a + p[1], 0) / f.ring.length;
    }
    const st = zoneStats(z.zone_id);
    const c = ZONE_COLOR[z.zone_id] || "#555";
    layers.labels.push(new kakao.maps.CustomOverlay({
      map, position: new kakao.maps.LatLng(y, x), zIndex: 5, yAnchor: 2.4,
      content: `<div class="zlabel" style="border-color:${c};color:${c}">${esc(z["구역명"])}<small>KPI ${st.reached}곳 / ${st.score}점</small></div>`,
    }));
  });
}

function drawMarks() {
  clear("marks");
  pocs.filter(p => passItem(p)).forEach(p => {
    const its = itemsOf(p);
    const el = document.createElement("div");
    el.className = "mk" + (its.length ? "" : " zero") + (passZone(p) ? "" : " dim") + (pocSel === p.place_id ? " sel" : "");
    el.innerHTML = donut(its, p.score);
    el.title = `${p.poc}  ${its.map(i => i.key).join(", ") || "항목 없음"}`;
    el.onclick = e => { e.stopPropagation(); openPoc(p.place_id); };
    layers.marks.push(new kakao.maps.CustomOverlay({
      map, clickable: true, content: el, position: new kakao.maps.LatLng(p.lat, p.lng),
      zIndex: pocSel === p.place_id ? 9 : 4 + Math.min(p.score, 40) / 100,
    }));
  });
}

function renderSummary() {
  const st = zoneStats(undefined, true);
  $("summary").innerHTML = `<span>KPI 도달 <b>${st.reached}</b>곳 / ${st.total}곳</span><span>KPI 합계 <b>${st.score}</b>점</span>`;
}

function renderLegend() {
  // 범례 숫자는 고른 구역 안의 POC 수. 항목을 꺼도 숫자는 그대로라 한눈에 비교할 수 있다
  const st = zoneSel ? zoneStats(zoneSel === "기타" ? "" : zoneSel) : zoneStats(undefined, true);
  $("legend").innerHTML = ITEMS.filter(it => !it.optional || st.counts[it.key]).map(it =>
    `<button class="lg${selected.has(it.key) ? " on" : ""}${st.counts[it.key] ? "" : " empty"}" data-item="${esc(it.key)}">`
    + `<i style="background:${it.color}"></i>${esc(it.key)} <b>${st.counts[it.key]}</b></button>`).join("")
    + `<button class="lg opt${matchAll ? "" : " off"}" id="matchAll" title="켠 항목을 모두 가진 POC만 보기">모두 포함</button>`
    + (selected.size ? `<button class="lg" id="clearSel">선택 해제</button>` : "");
  $("legend").querySelectorAll("[data-item]").forEach(b => b.onclick = () => {
    selected.has(b.dataset.item) ? selected.delete(b.dataset.item) : selected.add(b.dataset.item);
    refresh();
  });
  $("matchAll").onclick = () => { matchAll = !matchAll; refresh(); };
  if ($("clearSel")) $("clearSel").onclick = () => { selected.clear(); refresh(); };
}

/* ---------------- 오른쪽 패널 ---------------- */

function miniCounts(counts) {
  const parts = ITEMS.filter(it => counts[it.key]).map(it => `<span><i style="background:${it.color}"></i>${counts[it.key]}</span>`);
  return parts.length ? `<div class="mini">${parts.join("")}</div>` : "";
}

function renderZoneBox() {
  const ids = [...ZONES.map(z => z.zone_id), "기타"];
  const rows = ids.map(id => {
    const z = ZONES.find(z => z.zone_id === id);
    const st = zoneStats(id === "기타" ? "" : id);
    if (!z && !st.total) return "";
    const poc = z ? Number(z["POC 수"]) || 0 : 0;
    const rate = poc ? Math.round((st.reached / poc) * 100) : 0;
    const c = ZONE_COLOR[id] || GRAY;
    return `<tr class="row${zoneSel === id ? " sel" : ""}" data-zone="${esc(id)}">
      <td><div class="zname"><span class="zdot" style="background:${c}"></span>${esc(z ? z["구역명"] : "기타")}<small>${esc(id)}</small></div>
        ${miniCounts(st.counts)}
        ${poc ? `<div class="bar2" title="구역 POC ${poc}곳 중 KPI 도달 ${st.reached}곳"><span style="width:${Math.min(rate, 100)}%"></span></div>` : ""}</td>
      <td class="num">${st.reached}${poc ? ` / ${poc}` : ""}<small style="display:block;color:#667">${poc ? rate + "%" : ""}</small></td>
      <td class="num"><b>${st.score}</b></td></tr>`;
  }).join("");
  $("side").innerHTML = `<h2>구역 요약</h2>
    <div class="sub">KPI 도달 POC / 구역 POC 수. 행을 누르면 그 구역을 강조합니다</div>
    <table class="zt" style="margin-top:10px"><thead><tr><th>구역</th><th class="num">도달 / POC</th><th class="num">KPI</th></tr></thead><tbody>${rows}</tbody></table>
    <h3>항목별 색</h3><div class="chips">${ITEMS.filter(it => !it.optional).map(it =>
      `<span class="chip" style="background:${it.color};color:${it.ink}">${esc(it.key)}</span>`).join("")}</div>
    <div class="sub" style="margin-top:8px">마커는 사입 항목 수만큼 나뉘고 가운데 숫자가 KPI Score입니다. 회색 마커는 아직 사입 항목이 없는 POC입니다</div>`;
  $("side").querySelectorAll("[data-zone]").forEach(r => r.onclick = () => selectZone(r.dataset.zone));
}

function renderPoc(p) {
  const flagChips = Object.keys(p.flags).filter(f => p.flags[f]).map(f => {
    const it = FLAG_ITEM[f];
    return `<span class="chip" style="background:${it ? it.color : GRAY};color:${it ? it.ink : "#fff"}">${esc(FLAG_LABEL[f] || f)}</span>`;
  }).join("");
  const tags = plain(p.customers) ? plain(p.customers).split(/\s*,\s*/).map(t => `<span class="tag">${esc(t)}</span>`).join(" ") : "";
  const block = (title, v) => `<h3>${title}</h3>` + (plain(v) ? `<div class="txt">${esc(plain(v))}</div>` : `<div class="none">기록 없음</div>`);
  $("side").innerHTML = `<button class="back" id="back">← 구역 요약</button>
    <h2>${esc(p.poc)}</h2>
    <div class="sub">${esc(zoneName(p.zone_id))}${p.address ? " / " + esc(p.address) : ""}</div>
    <div class="score"><b>${p.score}</b>점 KPI Score</div>
    <div class="chips">${flagChips || `<span class="none">아직 사입 항목이 없습니다</span>`}</div>
    <div class="meta" style="margin-top:10px"><span>일자</span><span>${esc(p.date) || "기록 없음"}</span><span>증빙</span><span>${p.proof ? "있음" : "없음"}</span></div>
    ${block("Needs", p.needs)}${block("Solution", p.solution)}
    <h3>외국인과 단골 고객 언급</h3>${tags || `<div class="none">기록 없음</div>`}
    ${block("사입 방법", p.method)}`;
  $("back").onclick = () => closePoc();
}

function renderSide() {
  const p = pocs.find(x => x.place_id === pocSel);
  p ? renderPoc(p) : renderZoneBox();
  $("side").scrollTop = 0;
}

/* ---------------- 동작 ---------------- */

function refresh() {
  renderSummary();
  renderLegend();
  drawZones();
  drawMarks();
  renderSide();
}

function selectZone(id) {
  zoneSel = zoneSel === id ? "" : id;
  pocSel = null;
  if (zoneSel && zoneSel !== "기타") {
    const rings = zoneFeatures.filter(f => f.zone_id === zoneSel).flatMap(f => f.ring);
    if (rings.length) {
      const b = new kakao.maps.LatLngBounds();
      rings.forEach(([x, y]) => b.extend(new kakao.maps.LatLng(y, x)));
      const c = covered();
      map.setBounds(b, 110, c.right + 30, c.bottom + 30, 40);
    }
  }
  $("side").classList.remove("off");
  refresh();
}

function openPoc(placeId) {
  pocSel = placeId;
  const p = pocs.find(x => x.place_id === placeId);
  if (p) map.panTo(new kakao.maps.LatLng(p.lat, p.lng));
  $("side").classList.remove("off");
  drawMarks();
  renderSide();
}

function closePoc() {
  pocSel = null;
  drawMarks();
  renderSide();
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

// 개발용: ?fixture=경로 가 있으면 API 대신 로컬 JSON을 읽는다 (common.js와 같은 방식)
const fixturePath = () => new URLSearchParams(location.search).get("fixture");

async function fetchKpi() {
  const fixture = fixturePath();
  if (fixture) return await (await fetch(fixture)).json();
  return Api.call("kpiMap");
}

async function load() {
  const body = await fetchKpi();
  const data = body.data || {};
  fetchedAt = body.fetchedAt || "";
  ZONES = (data.zones || []).filter(z => z.zone_id);
  zoneFeatures = parseFeatures(ZONES);
  pocs = data.items || [];
  unmatched = data.unmatched || [];
  $("stamp").textContent = `시트 기준 ${fetchedAt} 총 ${pocs.length}곳`;
  if (unmatched.length) {
    fail(`지도에 올리지 못한 POC ${unmatched.length}곳: ${esc(unmatched.join(", "))}. 시트 "KPI 정리" 탭에 place_id를 넣으세요.`, true);
  } else hideFail();
  refresh();
}

async function start() {
  const s = Store.settings();
  if ((!fixturePath() && (!s.url || !s.token)) || !s.kakao) {
    return fail('설정이 비어 있습니다. <a href="field.html">현장 모드</a>에서 Apps Script URL과 토큰, 카카오 JS 키를 먼저 넣으세요. 같은 기기에 저장되므로 한 번만 넣으면 됩니다.');
  }
  try {
    await loadKakao(s.kakao);
  } catch (err) {
    return fail(esc(err.message) + " 카카오 JS 키에 이 주소의 도메인이 등록되어 있어야 합니다.");
  }
  initMap();
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  $("sideToggle").onclick = () => $("side").classList.toggle("off");
  // 폰에서는 패널을 접어 두고 지도를 먼저 보여 준다. 화면 폭이 바뀌면(가로 회전, 창 조절) 그에 맞춘다
  const phoneQuery = window.matchMedia("(max-width: 720px)");
  $("side").classList.toggle("off", phoneQuery.matches);
  phoneQuery.addEventListener("change", e => $("side").classList.toggle("off", e.matches));
  $("reload").onclick = async () => {
    $("reload").disabled = true;
    try { await load(); } catch (err) { fail(esc(err.message)); } finally { $("reload").disabled = false; }
  };
  try {
    await load();
  } catch (err) {
    fail(esc(err.message));
  }
}

start();
