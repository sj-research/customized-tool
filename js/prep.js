// 준비 모드: 지도에서 빈 곳을 보고, 업장 브리핑을 읽고, 오늘 방문 순서를 직접 정한다
// 앱은 순서를 제안하지 않는다. 후보를 보여주고 순서 편집만 돕는다

const STATUS = {
  미조사: { color: "#e8590c", label: "미조사" },
  완료: { color: "#2b8a3e", label: "조사 완료" },
  재방문: { color: "#c2255c", label: "재방문 필요" },
  제외: { color: "#adb5bd", label: "제외" },
};
const ZONE_COLORS = {
  Z1: "#e6194b", Z2: "#f58231", Z3: "#c9a100", Z4: "#3cb44b", Z5: "#4363d8",
  Z6: "#911eb4", Z7: "#f032e6", Z8: "#0fa3b1", Z9: "#9a6324",
};
const OPEN_ACTION = new Set(["대기", "진행"]);

const state = {
  data: null, fetchedAt: "", fixture: false,
  places: [], byId: {}, zones: [], zoneById: {},
  selectedZones: new Set(),
  plan: { plan_id: "", date: todayKST(), order: [], memo: "" },
  dirty: false,
  current: null,
  map: null, overlays: {}, polygons: [], routeLine: null,
};

const $ = id => document.getElementById(id);

/* ---------------- 데이터 가공 ---------------- */

function buildModel(data) {
  const obsBy = groupBy(data.observations, "place_id");
  const actBy = groupBy(data.actions.filter(a => OPEN_ACTION.has(a["상태"])), "place_id");
  const visitBy = groupBy(data.visits || [], "place_id");
  const blogBy = Object.fromEntries((data.blog || []).map(b => [b.place_id, b]));
  const nameCount = countBy(data.places, "상호명");

  state.zones = data.zones.map(z => ({ ...z, geometry: parseBoundary(z["경계"]), actions: actBy[z.zone_id] || [] }));
  state.zoneById = Object.fromEntries(state.zones.map(z => [z.zone_id, z]));

  state.places = data.places.map(p => {
    const obs = (obsBy[p.place_id] || []).sort((a, b) => String(b["조사일시"]).localeCompare(String(a["조사일시"])));
    const visits = (visitBy[p.place_id] || []).sort((a, b) => String(b["방문일시"]).localeCompare(String(a["방문일시"])));
    return {
      ...p,
      // 같은 상호명이 여러 곳이면 주소를 붙여 구분한다 (데이터 기준은 상호명)
      displayName: nameCount[p["상호명"]] > 1 ? `${p["상호명"]} (${p["주소"] || p["위치서술"] || p.zone_id})` : p["상호명"],
      hasCoord: typeof p.lat === "number" && typeof p.lng === "number",
      obs, visits, actions: actBy[p.place_id] || [], blog: blogBy[p.place_id] || null,
      status: placeStatus(p, obs, visits),
    };
  });
  state.byId = Object.fromEntries(state.places.map(p => [p.place_id, p]));
}

function placeStatus(p, obs, visits) {
  if (p["진행상태"] === "제외") return "제외";
  const latest = visits[0];
  if (p["진행상태"] === "재방문필요" || (latest && latest["방문 결과"] && latest["방문 결과"] !== "완료")) return "재방문";
  if (["관측완료", "상담완료"].includes(p["진행상태"]) || obs.length || visits.length) return "완료";
  return "미조사";
}

function parseBoundary(value) {
  try {
    const g = JSON.parse(value);
    return g && g.type === "MultiPolygon" ? g : null;
  } catch (e) {
    return null;
  }
}

function groupBy(rows, key) {
  return rows.reduce((acc, r) => ((acc[r[key]] = acc[r[key]] || []).push(r), acc), {});
}

function countBy(rows, key) {
  return rows.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] || 0) + 1), acc), {});
}

/* ---------------- 지도 ---------------- */

function initMap() {
  state.map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(37.5685, 127.0085), level: 4 });
  state.map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
}

function drawZones() {
  state.polygons.forEach(p => p.setMap(null));
  state.polygons = [];
  state.zones.forEach(z => {
    if (!z.geometry) return;
    const on = state.selectedZones.has(z.zone_id);
    const color = ZONE_COLORS[z.zone_id] || "#555";
    z.geometry.coordinates.forEach(poly => {
      const path = poly[0].map(([lng, lat]) => new kakao.maps.LatLng(lat, lng));
      state.polygons.push(new kakao.maps.Polygon({
        map: state.map, path, strokeWeight: on ? 3 : 1.5, strokeColor: color, strokeOpacity: on ? 0.95 : 0.5,
        strokeStyle: on ? "solid" : "shortdash", fillColor: color, fillOpacity: on ? 0.18 : 0.03,
      }));
    });
  });
}

function drawMarkers() {
  Object.values(state.overlays).forEach(o => o.setMap(null));
  state.overlays = {};
  const anySelected = state.selectedZones.size > 0;
  state.places.filter(p => p.hasCoord).forEach(p => {
    const el = document.createElement("button");
    const orderIdx = state.plan.order.indexOf(p.place_id);
    const dim = anySelected && !state.selectedZones.has(p.zone_id);
    el.className = "mk" + (orderIdx >= 0 ? " in-route" : "") + (p.status === "제외" ? " excluded" : "") + (dim ? " dim" : "");
    el.style.background = STATUS[p.status].color;
    el.title = p.displayName;
    el.innerHTML = (orderIdx >= 0 ? `<span class="no">${orderIdx + 1}</span>` : "") +
      (p.actions.length ? `<span class="badge">${p.actions.length}</span>` : "");
    el.onclick = e => { e.stopPropagation(); openBriefing(p.place_id); };
    state.overlays[p.place_id] = new kakao.maps.CustomOverlay({
      map: state.map, position: new kakao.maps.LatLng(p.lat, p.lng), content: el, clickable: true,
      zIndex: orderIdx >= 0 ? 5 : dim ? 1 : 3,
    });
  });
  drawRouteLine();
  renderLegend();
}

function drawRouteLine() {
  if (state.routeLine) state.routeLine.setMap(null);
  const path = state.plan.order.map(id => state.byId[id]).filter(p => p && p.hasCoord)
    .map(p => new kakao.maps.LatLng(p.lat, p.lng));
  state.routeLine = path.length > 1
    ? new kakao.maps.Polyline({ map: state.map, path, strokeWeight: 3, strokeColor: "#1f3a5f", strokeOpacity: 0.8, strokeStyle: "solid" })
    : null;
}

function renderLegend() {
  const pool = state.selectedZones.size ? state.places.filter(p => state.selectedZones.has(p.zone_id)) : state.places;
  const counts = countBy(pool, "status");
  const withAction = pool.filter(p => p.actions.length).length;
  $("legend").innerHTML = Object.keys(STATUS).map(k =>
    `<span><i style="background:${STATUS[k].color}"></i>${STATUS[k].label} ${counts[k] || 0}</span>`).join("") +
    `<span><i class="lg-badge"></i>미해결 액션 ${withAction}</span>`;
}

/* ---------------- 구역 선택 ---------------- */

function renderZoneChips() {
  $("zoneChips").innerHTML = state.zones.map(z => {
    const n = state.places.filter(p => p.zone_id === z.zone_id && p.status === "미조사").length;
    return `<button class="chip ${state.selectedZones.has(z.zone_id) ? "on" : ""}" data-zone="${esc(z.zone_id)}"
      style="--zc:${ZONE_COLORS[z.zone_id] || "#555"}">${esc(z.zone_id)} ${esc(z["구역명"])} <small>미조사 ${n}</small></button>`;
  }).join("");
  $("zoneChips").querySelectorAll(".chip").forEach(b => {
    b.onclick = () => {
      const id = b.dataset.zone;
      state.selectedZones.has(id) ? state.selectedZones.delete(id) : state.selectedZones.add(id);
      markDirty();
      renderZoneChips();
      drawZones();
      drawMarkers();
      renderRoute();
    };
  });
  const missing = state.zones.filter(z => !z.geometry).map(z => z.zone_id);
  $("zoneNotice").hidden = missing.length === 0;
  $("zoneNotice").textContent = missing.length
    ? `구역 경계가 시트에 없습니다: ${missing.join(", ")}. 연결 테스트 페이지에서 zones.geojson을 올리세요.` : "";
}

/* ---------------- 브리핑 ---------------- */

function openBriefing(placeId) {
  const p = state.byId[placeId];
  if (!p) return;
  state.current = placeId;
  const zone = state.zoneById[p.zone_id];
  const inRoute = state.plan.order.includes(placeId);
  const kind = p["업태서술"] || (p["카카오 업종"] || "").split(">").slice(1).map(s => s.trim()).join(" > ");

  const actions = p.actions.length
    ? p.actions.map(a => `<li><b>${esc(a["액션유형"])}</b> ${esc(a["확인할내용"])} <small>${esc(a["우선순위"] || "")}</small></li>`).join("")
    : `<li class="muted">없음</li>`;

  const obs = p.obs.length ? p.obs.map(o => {
    const chips = [
      o["생맥주"] && `생맥주 ${o["생맥주"]}`, o["병맥주"] && `병맥주 ${o["병맥주"]}`,
      o["자사브랜드"] && `자사 ${o["자사브랜드"]}`, o["경쟁브랜드"] && `경쟁 ${o["경쟁브랜드"]}`,
      o["POCM유무"] && `POCM ${o["POCM유무"]}${o["POCM브랜드"] ? " " + o["POCM브랜드"] : ""}`,
    ].filter(Boolean).map(c => `<span class="tag">${esc(c)}</span>`).join("");
    return `<li><div class="obs-head">${esc(o["조사일시"])} / ${esc(o["근거유형"])}</div>${esc(o["특이사항"] || "")}<div>${chips}</div></li>`;
  }).join("") : `<li class="muted">기록 없음</li>`;

  const visits = p.visits.length ? `<h4>방문 기록</h4><ul>${p.visits.map(v =>
    `<li>${esc(v["방문일시"])} ${esc(v["방문 결과"] || "")} ${v["재방문 희망 시각"] ? "/ 재방문 " + esc(v["재방문 희망 시각"]) : ""}</li>`).join("")}</ul>` : "";

  $("briefing").innerHTML = `
    <div class="b-head">
      <div>
        <h3>${esc(p.displayName)}</h3>
        <div class="muted">${esc(p.zone_id)} ${esc(zone ? zone["구역명"] : "")}</div>
      </div>
      <span class="pill" style="background:${STATUS[p.status].color}">${STATUS[p.status].label}</span>
    </div>
    <dl>
      <dt>주소</dt><dd>${esc(p["주소"] || "없음")}${p.hasCoord ? "" : ` <span class="warn">좌표 없음</span>`}</dd>
      ${p["위치서술"] ? `<dt>위치</dt><dd>${esc(p["위치서술"])}</dd>` : ""}
      <dt>업태</dt><dd>${esc(kind || "미확인")}</dd>
      ${p["비고"] ? `<dt>비고</dt><dd>${esc(p["비고"])}</dd>` : ""}
    </dl>
    <h4>확인할 것 <small>(미해결 액션)</small></h4><ul class="actions">${actions}</ul>
    <h4>이전 관측</h4><ul class="obs">${obs}</ul>
    ${visits}
    <h4>블로그</h4>${blogBlock(p.blog)}
    <div class="b-actions">
      <button class="primary" id="toggleRoute">${inRoute ? "오늘 경로에서 빼기" : "오늘 경로에 추가"}</button>
      ${p["지도링크"] ? `<a class="secondary" href="${esc(p["지도링크"])}" target="_blank" rel="noopener">카카오맵</a>` : ""}
    </div>`;
  $("toggleRoute").onclick = () => { toggleRoute(placeId); openBriefing(placeId); };
  showTab("briefing");
  setSheet("half");
  if (p.hasCoord) state.map.panTo(new kakao.maps.LatLng(p.lat, p.lng));
}

function blogBlock(b) {
  if (!b) return `<p class="muted">데이터 없음</p>`;
  if (b["상호명검색 전체 언급량"] === null || b["상호명검색 전체 언급량"] === undefined) {
    return `<p class="muted">${esc(b["비고"] || "검색하지 않음")}</p>`;
  }
  const row = (label, v) => `<dt>${label}</dt><dd>${esc(v ?? "없음")}</dd>`;
  const cautions = [
    b["짧은 상호명"] === "Y" && "상호명이 2글자 이하",
    b["매칭 충돌 업장"] && `같은 글이 다른 업장에도 집계됨: ${b["매칭 충돌 업장"]}`,
    Number(b["공백 무시로만 잡힌 포스트 수"]) > 0 && `띄어쓰기를 지워야만 잡힌 글 ${b["공백 무시로만 잡힌 포스트 수"]}건`,
  ].filter(Boolean);
  return `<dl>
    ${row("일치 포스트", b["상호명검색 일치 포스트 수"])}
    ${row("최근 1년", b["상호명검색 최근1년 포스트 수"])}
    ${row("최신 포스트", b["상호명검색 최신 포스트 일자"])}
    ${row("지역 키워드 등장", b["지역키워드 등장 포스트 수"])}
    ${row("협찬 의심", b["지역키워드 협찬 의심 포스트 수"])}
  </dl>${cautions.length ? `<p class="warn">수치 주의: ${cautions.map(esc).join(" / ")}</p>` : ""}
  <p class="muted small">수집일 ${esc(b["수집일"])}</p>`;
}

/* ---------------- 오늘 경로 ---------------- */

function toggleRoute(placeId) {
  const i = state.plan.order.indexOf(placeId);
  i >= 0 ? state.plan.order.splice(i, 1) : state.plan.order.push(placeId);
  markDirty();
  drawMarkers();
  renderRoute();
}

function moveRoute(i, delta) {
  const j = i + delta;
  const order = state.plan.order;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  markDirty();
  drawMarkers();
  renderRoute();
}

function renderRoute() {
  $("routeCount").textContent = state.plan.order.length ? `(${state.plan.order.length})` : "";
  $("planDate").value = state.plan.date;
  $("planMemo").value = state.plan.memo;

  const plans = (state.data.routing_plans || []).filter(r => r["날짜"] === state.plan.date);
  $("planSelect").innerHTML = `<option value="">새 계획</option>` + plans.map(r =>
    `<option value="${esc(r.plan_id)}" ${r.plan_id === state.plan.plan_id ? "selected" : ""}>${esc(r.plan_id)} / ${esc(r["대상 구역"] || "")} / ${String(r["방문 순서"] || "").split(",").filter(Boolean).length}곳</option>`).join("");

  $("routeList").innerHTML = state.plan.order.length ? state.plan.order.map((id, i) => {
    const p = state.byId[id];
    if (!p) return "";
    return `<li>
      <span class="no" style="background:${STATUS[p.status].color}">${i + 1}</span>
      <button class="link" data-open="${esc(id)}">${esc(p.displayName)}</button>
      <small>${esc(p.zone_id)}${p.hasCoord ? "" : " / 좌표 없음"}${p.actions.length ? ` / 액션 ${p.actions.length}` : ""}</small>
      <span class="ops">
        <button data-move="${i}" data-d="-1" aria-label="위로">▲</button>
        <button data-move="${i}" data-d="1" aria-label="아래로">▼</button>
        <button data-remove="${esc(id)}" aria-label="빼기">✕</button>
      </span></li>`;
  }).join("") : `<li class="muted">지도나 검색에서 업장을 골라 "오늘 경로에 추가"를 누르세요.</li>`;

  $("routeList").querySelectorAll("[data-open]").forEach(b => b.onclick = () => openBriefing(b.dataset.open));
  $("routeList").querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveRoute(+b.dataset.move, +b.dataset.d));
  $("routeList").querySelectorAll("[data-remove]").forEach(b => b.onclick = () => toggleRoute(b.dataset.remove));

  const zoneActs = [...state.selectedZones].flatMap(z => (state.zoneById[z] || { actions: [] }).actions.map(a => ({ z, a })));
  $("zoneActions").innerHTML = zoneActs.length
    ? zoneActs.map(({ z, a }) => `<li><b>${esc(z)}</b> ${esc(a["액션유형"])} ${esc(a["확인할내용"])}</li>`).join("")
    : `<li class="muted">선택한 구역의 구역 단위 액션 없음</li>`;
  $("zoneSelLabel").textContent = state.selectedZones.size ? [...state.selectedZones].sort().join(", ") : "선택 안 함";
  $("saveState").textContent = state.dirty ? "저장하지 않은 변경이 있습니다" : state.plan.plan_id ? `저장됨 / ${state.plan.plan_id}` : "";
}

function loadPlan(planId) {
  const r = (state.data.routing_plans || []).find(x => x.plan_id === planId);
  if (!r) {
    state.plan = { plan_id: "", date: state.plan.date, order: [], memo: "" };
  } else {
    const ids = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);
    state.plan = { plan_id: r.plan_id, date: r["날짜"], order: ids(r["방문 순서"]).filter(id => state.byId[id]), memo: r["메모"] || "" };
    state.selectedZones = new Set(ids(r["대상 구역"]));
  }
  state.dirty = false;
  renderZoneChips();
  drawZones();
  drawMarkers();
  renderRoute();
}

async function savePlan() {
  if (!state.plan.order.length) return toast("경로에 업장이 없습니다");
  if (state.fixture) return toast("개발용 데이터에서는 저장하지 않습니다");
  $("savePlan").disabled = true;
  toast("저장 중...");
  try {
    const body = await Api.savePlan({
      plan_id: state.plan.plan_id || undefined, date: state.plan.date,
      zones: [...state.selectedZones].sort(), order: state.plan.order, memo: state.plan.memo,
    });
    const saved = { ...body.plan };
    const list = state.data.routing_plans = state.data.routing_plans || [];
    const i = list.findIndex(x => x.plan_id === saved.plan_id);
    i >= 0 ? (list[i] = saved) : list.push(saved);
    Store.saveCache({ fetchedAt: state.fetchedAt, data: state.data });
    state.plan.plan_id = saved.plan_id;
    state.dirty = false;
    renderRoute();
    toast("저장했습니다");
  } catch (err) {
    toast("저장 실패: " + err.message);
  } finally {
    $("savePlan").disabled = false;
  }
}

function markDirty() {
  state.dirty = true;
}

/* ---------------- 검색 ---------------- */

function renderSearch(q) {
  const box = $("searchResults");
  const key = q.replace(/\s+/g, "").toLowerCase();
  if (!key) { box.hidden = true; return; }
  const hits = state.places.filter(p => p.displayName.replace(/\s+/g, "").toLowerCase().includes(key)).slice(0, 12);
  box.hidden = false;
  box.innerHTML = hits.length ? hits.map(p =>
    `<li><button data-id="${esc(p.place_id)}"><i style="background:${STATUS[p.status].color}"></i>${esc(p.displayName)}
      <small>${esc(p.zone_id)}${p.hasCoord ? "" : " / 좌표 없음"}</small></button></li>`).join("")
    : `<li class="muted">결과 없음</li>`;
  box.querySelectorAll("button[data-id]").forEach(b => b.onclick = () => {
    $("search").value = "";
    box.hidden = true;
    openBriefing(b.dataset.id);
  });
}

/* ---------------- 화면 틀 ---------------- */

function showTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === name));
  document.querySelectorAll(".pane").forEach(p => (p.hidden = p.id !== name));
}

function setSheet(size) {
  $("sheet").dataset.size = size;
}

let toastTimer;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 2600);
}

function openSettings(message) {
  const s = Store.settings();
  $("setUrl").value = s.url;
  $("setToken").value = s.token;
  $("setKakao").value = s.kakao;
  $("settingsMsg").textContent = message || "";
  $("settings").hidden = false;
}

async function refresh(fromServer) {
  const cached = Store.cached();
  let payload = !fromServer && cached && !new URLSearchParams(location.search).get("fixture") ? cached : null;
  if (!payload) {
    $("dataInfo").textContent = "데이터 받는 중...";
    payload = await Api.loadData();
    if (!payload.fixture && !Store.saveCache({ fetchedAt: payload.fetchedAt, data: payload.data })) {
      toast("기기에 데이터를 보관하지 못했습니다. 다음에 다시 받습니다");
    }
  }
  state.data = payload.data;
  state.fetchedAt = payload.fetchedAt;
  state.fixture = !!payload.fixture;
  $("dataInfo").textContent = `${payload.fixture ? "개발용 데이터" : "데이터"} ${payload.fetchedAt}`;
  buildModel(state.data);
}

async function start() {
  $("refresh").onclick = async () => {
    if (state.dirty && !confirm("저장하지 않은 경로가 있습니다. 데이터를 새로 받으면 경로 편집은 유지됩니다. 계속할까요?")) return;
    try {
      await refresh(true);
      renderZoneChips(); drawZones(); drawMarkers(); renderRoute();
      if (state.current) openBriefing(state.current);
      toast("최신 데이터를 받았습니다");
    } catch (err) {
      toast("새로고침 실패: " + err.message);
    }
  };
  $("openSettings").onclick = () => openSettings();
  $("closeSettings").onclick = () => ($("settings").hidden = true);
  $("saveSettings").onclick = () => {
    Store.saveSettings({ url: $("setUrl").value, token: $("setToken").value, kakao: $("setKakao").value });
    location.reload();
  };
  document.querySelectorAll(".tab").forEach(t => t.onclick = () => { showTab(t.dataset.tab); setSheet("half"); });
  $("handle").onclick = () => setSheet({ min: "half", half: "full", full: "min" }[$("sheet").dataset.size] || "half");
  $("search").oninput = e => renderSearch(e.target.value);
  $("planDate").onchange = e => { state.plan.date = e.target.value; state.plan.plan_id = ""; markDirty(); renderRoute(); };
  $("planMemo").oninput = e => { state.plan.memo = e.target.value; markDirty(); $("saveState").textContent = "저장하지 않은 변경이 있습니다"; };
  $("planSelect").onchange = e => {
    if (state.dirty && !confirm("저장하지 않은 변경이 사라집니다. 불러올까요?")) return renderRoute();
    loadPlan(e.target.value);
  };
  $("savePlan").onclick = savePlan;
  $("clearRoute").onclick = () => { if (confirm("경로를 비울까요?")) { state.plan.order = []; markDirty(); drawMarkers(); renderRoute(); } };
  window.addEventListener("beforeunload", e => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

  const fixture = new URLSearchParams(location.search).get("fixture");
  const s = Store.settings();
  if (!fixture && (!s.url || !s.token || !s.kakao)) return openSettings("처음 한 번 설정이 필요합니다.");

  try {
    await loadKakao(s.kakao);
  } catch (err) {
    return openSettings(err.message);
  }
  initMap();
  try {
    await refresh(false);
  } catch (err) {
    $("dataInfo").textContent = "데이터 없음";
    return openSettings("데이터를 받지 못했습니다: " + err.message);
  }
  state.dirty = false;
  renderZoneChips();
  drawZones();
  drawMarkers();
  renderRoute();
  showTab("route");
  setSheet("min");
}

start();
