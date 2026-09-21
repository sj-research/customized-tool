// 현장 지도 MVP (01_schema/field-map-mvp.md)
// 지도 하나. 구역 폴리곤, 상태별 마커, 현재 위치와 이동 경로, 마커 탭으로 상태 변경, 길게 눌러 임의 핀 추가

/* ---------------- 설정값 ---------------- */

const MARKER_MAX_LEVEL = 3;        // 카카오 지도 레벨이 이 값 이하(가까이)일 때만 개별 마커를 보인다
const TRACK_MIN_METERS = 20;       // 이동 경로 점: 20미터 이상 움직였거나
const TRACK_MIN_SECONDS = 10;      // 10초가 지났을 때 찍는다
const TRACK_MAX_ACCURACY = 50;     // 정확도가 이보다 나쁜(미터) 위치는 경로에 넣지 않는다. 튀는 선 방지
const LONG_PRESS_MS = 600;         // 길게 누르기 판정 시간
const MAP_CACHE_KEY = "cet.map.v1";
const TRACK_KEY = "cet.track.v1";

// 시트 진행상태 값 → 앱 상태 4가지
const SHEET_TO_APP = { "미방문": "미조사", "관측완료": "완료", "상담완료": "완료", "재방문필요": "재방문", "제외": "제외" };
// 앱 버튼 → 시트에 쓰는 값. 완료는 관측완료를 쓴다 (상담완료는 서버가 덮어쓰지 않는다)
const APP_TO_SHEET = { "미조사": "미방문", "완료": "관측완료", "재방문": "재방문필요", "제외": "제외" };
const STATUS_ORDER = ["미조사", "완료", "재방문", "제외"];
const STATUS_COLOR = { "미조사": "#e8590c", "완료": "#2b8a3e", "재방문": "#c2255c", "제외": "#868e96" };
const BEES_COLOR = "#f1c40f";   // Bees 인덱스 색 (9월 21일 결정)
const REVISIT_REASONS = ["키맨 부재", "브레이크 타임", "영업 전", "기타"];

const $ = id => document.getElementById(id);
const fixtureMode = !!new URLSearchParams(location.search).get("fixture");

const state = {
  places: [],            // 좌표와 매핑되는 진행상태가 있는 행만
  byId: {},
  zones: [],
  blogRank: [],          // 블로그 노출 목록. 목록 화면에서만 쓴다
  map: null,
  overlays: {},          // place_id → { overlay, el }
  markersVisible: false,
  selected: null,
  pending: {},           // place_id → 서버 응답 대기 중인 요청 번호
  confirmed: {},         // place_id → 서버에 반영된 마지막 값 { 진행상태, 재방문사유, 재방문예정시각, 관리 }
  seq: 0,
  watchId: null, wantTracking: false, follow: false,
  me: null, meOverlay: null, heading: null,
  track: [], trackLine: null,
};

/* ---------------- 백엔드 ---------------- */

const Backend = {
  async mapData() {
    if (fixtureMode) {
      const body = await (await fetch(new URLSearchParams(location.search).get("fixture"))).json();
      return { fetchedAt: body.fetchedAt, data: { zones: body.data.zones, places: body.data.places, blogRank: body.data.blogRank || [] } };
    }
    const body = await Api.call("mapData");
    return { fetchedAt: body.fetchedAt, data: body.data };
  },
  async setStatus(placeId, status, reason, time, manage) {
    if (fixtureMode) return devReply({ ok: true, place_id: placeId, "진행상태": status, "재방문사유": reason || "", "재방문예정시각": time || "", "관리": status === "관측완료" && manage === true });
    return Api.call("setStatus", { place_id: placeId, status, reason, time, manage });
  },
  async addPlace(name, lat, lng, kakao) {
    if (fixtureMode) {
      return devReply({ ok: true, duplicate: false, place: { place_id: "P9" + String(Date.now()).slice(-2), zone_id: zoneOfPoint(lng, lat), "상호명": name, lat, lng,
        "진행상태": "미방문", "출처": "현장추가", ...(kakao ? { kakao_id: kakao.id, "카카오 업종": kakao.category, "주소": kakao.address, "지도링크": kakao.url } : {}) } });
    }
    return Api.call("addPlace", { name, lat, lng, kakao });
  },
};

// 개발용: window.__failNext = "메시지" 로 다음 요청 한 번을 실패시킨다
async function devReply(value) {
  await new Promise(r => setTimeout(r, 600));
  if (window.__failNext) {
    const msg = window.__failNext;
    window.__failNext = null;
    throw new Error(msg);
  }
  return value;
}

/* ---------------- 데이터 ---------------- */

function applyData(data) {
  state.blogRank = data.blogRank || [];
  state.zones = data.zones.map(z => ({ ...z, geometry: parseBoundary(z["경계"]) }));
  const withCoord = data.places.filter(p => isNum(p.lat) && isNum(p.lng));
  const nameCount = countBy(withCoord, "상호명");
  state.places = [];
  withCoord.forEach(p => {
    if (!SHEET_TO_APP[p["진행상태"]]) {
      console.warn("진행상태 값을 알 수 없어 지도에서 뺀 행", p.place_id, p["진행상태"]);
      return;
    }
    state.places.push(decorate(p, nameCount));
  });
  state.byId = Object.fromEntries(state.places.map(p => [p.place_id, p]));
  // 서버 응답을 기다리는 변경은 새로 받은 데이터 위에 다시 얹는다
  Object.keys(state.pending).forEach(id => {
    const local = state.localValues && state.localValues[id];
    if (local && state.byId[id]) Object.assign(state.byId[id], local);
  });
  state.places.forEach(p => {
    if (!state.pending[p.place_id]) state.confirmed[p.place_id] = pick(p);
  });
}

function decorate(p, nameCount) {
  return {
    ...p,
    lat: Number(p.lat), lng: Number(p.lng),
    bees: isChecked(p["BEES"]),   // Bees 필수 방문 업장. 진행상태는 다른 업장과 같게 관리한다
    displayName: nameCount && nameCount[p["상호명"]] > 1 ? `${p["상호명"]} (${p["주소"] || p.zone_id || ""})` : p["상호명"],
  };
}

const pick = p => ({ "진행상태": p["진행상태"], "재방문사유": p["재방문사유"] || "", "재방문예정시각": p["재방문예정시각"] || "", "관리": isChecked(p["관리"]) });
const isChecked = v => v === true || String(v).toUpperCase() === "TRUE";
const appStatus = p => SHEET_TO_APP[p["진행상태"]];
const isNum = v => v !== null && v !== "" && !isNaN(Number(v));

function parseBoundary(value) {
  try {
    const g = JSON.parse(value);
    return g && g.type === "MultiPolygon" ? g : null;
  } catch (e) {
    return null;
  }
}

function countBy(rows, key) {
  return rows.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] || 0) + 1), acc), {});
}

function saveMapCache(fetchedAt) {
  if (fixtureMode) return;
  const places = state.places.map(p => {
    const { displayName, ...rest } = p;
    return { ...rest, ...(state.confirmed[p.place_id] || {}) };
  });
  Store.set(MAP_CACHE_KEY, JSON.stringify({ fetchedAt, data: { zones: state.zones.map(({ geometry, ...z }) => z), places, blogRank: state.blogRank } }));
}

/* ---------------- 상단 카운트 ---------------- */

function renderCounts() {
  const counts = countBy(state.places.map(p => ({ s: appStatus(p) })), "s");
  $("counts").innerHTML = STATUS_ORDER.map(s =>
    `<span class="cnt"><i style="background:${STATUS_COLOR[s]}"></i>${s} <b>${counts[s] || 0}</b></span>`).join("")
    + beesCount();
}

// Bees는 네 상태 숫자에도 함께 세고, 완료한 곳 수를 따로 보여준다
function beesCount() {
  const bees = state.places.filter(p => p.bees);
  if (!bees.length) return "";
  const done = bees.filter(p => appStatus(p) === "완료").length;
  return `<span class="cnt bees"><i></i>Bees <b>${done}/${bees.length}</b></span>`;
}

/* ---------------- 지도 ---------------- */

function initMap() {
  state.map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(37.5685, 127.0085), level: 4 });
  kakao.maps.event.addListener(state.map, "zoom_changed", updateMarkerVisibility);
  kakao.maps.event.addListener(state.map, "dragstart", () => setFollow(false));
  kakao.maps.event.addListener(state.map, "click", () => { closeSheet(); closeSearch(); });
  // PC에서는 오른쪽 클릭으로도 핀을 추가한다
  kakao.maps.event.addListener(state.map, "rightclick", e => openPinSheet(e.latLng.getLat(), e.latLng.getLng()));
  initLongPress();
}

// 구역 경계는 회색으로 그린다. 시트 zones 탭에 TOBE 행이 있으면 서버가 TOBE만 준다 (Zones Polygon 조사 현황 화면과 같은 색)
const ZONE_COLOR = "#8a8f98";
function drawZones() {
  state.zones.forEach(z => {
    if (!z.geometry) return;   // 신설동 S3, S4처럼 폴리곤 없이 정의한 구역은 그리지 않는다
    z.geometry.coordinates.forEach(poly => {
      new kakao.maps.Polygon({
        map: state.map, path: poly[0].map(([lng, lat]) => new kakao.maps.LatLng(lat, lng)),
        strokeWeight: 2, strokeColor: ZONE_COLOR, strokeOpacity: 0.95, fillColor: ZONE_COLOR, fillOpacity: 0.12,
      });
    });
  });
}

function rebuildMarkers() {
  Object.values(state.overlays).forEach(o => o.overlay.setMap(null));
  state.overlays = {};
  state.places.forEach(addMarker);
  updateMarkerVisibility();
}

function addMarker(p) {
  const el = document.createElement("button");
  el.className = "mk";
  el.onclick = e => { e.stopPropagation(); openSheet(p.place_id); };
  const overlay = new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(p.lat, p.lng), content: el, clickable: true, zIndex: 3,
  });
  state.overlays[p.place_id] = { overlay, el };
  paintMarker(p.place_id);
  if (state.markersVisible) overlay.setMap(state.map);
}

function paintMarker(placeId) {
  const o = state.overlays[placeId];
  const p = state.byId[placeId];
  if (!o || !p) return;
  // Bees는 점선 테두리. 방문 전에는 미조사 색 대신 Bees 색(노랑)으로 둔다
  o.el.classList.toggle("bees", p.bees);
  // 신설동 S3 감성 맛집은 회색 세모, S4 오래된 로컬 맛집은 회색 네모 테두리 (폴리곤 없이 업장으로 정의한 구역)
  o.el.classList.toggle("t-tri", p["TOBE 태그"] === "감성 맛집");
  o.el.classList.toggle("t-sq", p["TOBE 태그"] === "오래된 로컬");
  o.el.style.background = p.bees && appStatus(p) === "미조사" ? BEES_COLOR : STATUS_COLOR[appStatus(p)];
  o.el.classList.toggle("selected", state.selected === placeId);
  o.el.classList.toggle("pending", !!state.pending[placeId]);
  o.el.setAttribute("aria-label", `${p.bees ? "Bees " : ""}${p.displayName} ${appStatus(p)}`);
}

function updateMarkerVisibility() {
  const visible = state.map.getLevel() <= MARKER_MAX_LEVEL;
  if (visible !== state.markersVisible) {
    state.markersVisible = visible;
    Object.values(state.overlays).forEach(o => o.overlay.setMap(visible ? state.map : null));
  }
  $("zoomHint").hidden = visible;
}

/* ---------------- 마커 탭: 하단 시트 ---------------- */

function openSheet(placeId) {
  const prev = state.selected;
  state.selected = placeId;
  if (prev) paintMarker(prev);
  paintMarker(placeId);
  renderSheet();
}

function closeSheet() {
  if (!state.selected) return;
  const prev = state.selected;
  state.selected = null;
  paintMarker(prev);
  $("sheet").hidden = true;
}

function renderSheet(mode) {
  const p = state.byId[state.selected];
  if (!p) return closeSheet();
  const current = appStatus(p);
  const kind = p["업태서술"] || String(p["카카오 업종"] || "").split(">").slice(1).map(s => s.trim()).filter(Boolean).join(" > ");
  const revisitLine = current === "재방문"
    ? `<p class="revisit">재방문 사유: ${esc(p["재방문사유"] || "기록 없음")}${p["재방문예정시각"] ? ` / 예정 ${esc(p["재방문예정시각"])}` : ""}</p>` : "";
  const manageLine = current === "완료" && isChecked(p["관리"]) ? `<p class="manage">관리 업장</p>` : "";

  $("sheet").innerHTML = `
    <div class="s-head">
      <div><h3>${p.bees ? `<span class="bees-tag">Bees</span>` : ""}${esc(p.displayName)}</h3>${kind ? `<p class="muted">${esc(kind)}</p>` : ""}</div>
      <button class="x" id="closeSheet" aria-label="닫기">✕</button>
    </div>
    ${revisitLine}${manageLine}
    ${mode === "reason" ? reasonPicker() : mode === "complete" ? completePicker(isChecked(p["관리"])) : `
      <div class="st-btns">${STATUS_ORDER.map(s =>
        `<button class="st ${s === current ? "on" : ""}" data-st="${s}" style="--c:${STATUS_COLOR[s]}">${s}</button>`).join("")}</div>
      <p class="muted small" id="saving">${state.pending[p.place_id] ? "저장 중" : ""}</p>`}
    ${p["지도링크"] ? `<a class="kakao" href="${esc(p["지도링크"])}" target="_blank" rel="noopener">카카오맵에서 열기</a>` : ""}`;
  $("sheet").hidden = false;
  $("closeSheet").onclick = closeSheet;

  if (mode === "complete") {
    $("cancelComplete").onclick = () => renderSheet();
    $("okComplete").onclick = () => changeStatus(p.place_id, "완료", null, null, $("manageCheck").checked);
    return;
  }
  if (mode === "reason") {
    let reason = null;
    $("sheet").querySelectorAll("[data-reason]").forEach(b => b.onclick = () => {
      reason = b.dataset.reason;
      $("sheet").querySelectorAll("[data-reason]").forEach(x => x.classList.toggle("on", x === b));
      $("okReason").disabled = false;
    });
    $("cancelReason").onclick = () => renderSheet();
    $("okReason").onclick = () => changeStatus(p.place_id, "재방문", reason, $("revisitTime").value.trim());
    return;
  }
  $("sheet").querySelectorAll("[data-st]").forEach(b => b.onclick = () => {
    const next = b.dataset.st;
    if (next === "재방문") return renderSheet("reason");
    if (next === "완료") return renderSheet("complete"); // 이미 완료여도 관리 체크를 바꿀 수 있게 연다
    if (next === appStatus(p) && next !== "재방문") return; // 이미 그 상태. 상담완료도 여기서 걸러진다
    changeStatus(p.place_id, next);
  });
}

function completePicker(checked) {
  return `
    <label class="check"><input id="manageCheck" type="checkbox" ${checked ? "checked" : ""}> 관리 업장으로 체크</label>
    <div class="row">
      <button id="cancelComplete" class="secondary">취소</button>
      <button id="okComplete" class="primary">완료로 저장</button>
    </div>`;
}

function reasonPicker() {
  return `
    <p class="ask">재방문 사유</p>
    <div class="reasons">${REVISIT_REASONS.map(r => `<button class="reason" data-reason="${r}">${r}</button>`).join("")}</div>
    <label class="time">예정 시각 (들은 경우만) <input id="revisitTime" type="text" placeholder="예: 18:00" autocomplete="off"></label>
    <div class="row">
      <button id="cancelReason" class="secondary">취소</button>
      <button id="okReason" class="primary" disabled>재방문으로 저장</button>
    </div>`;
}

/* ---------------- 상태 변경: 화면 먼저, 전송은 뒤에서 ---------------- */

function changeStatus(placeId, appNext, reason, time, manage) {
  const p = state.byId[placeId];
  const revisit = appNext === "재방문";
  // 관리 체크는 완료일 때만 남는다. 다른 상태로 바꾸면 해제된다
  const local = { "진행상태": APP_TO_SHEET[appNext], "재방문사유": revisit ? reason : "", "재방문예정시각": revisit ? (time || "") : "",
                  "관리": appNext === "완료" && manage === true };

  // 화면을 먼저 바꾼다
  state.localValues = state.localValues || {};
  state.localValues[placeId] = local;
  state.pending[placeId] = ++state.seq;
  Object.assign(p, local);
  paintMarker(placeId);
  renderCounts();
  if (state.selected === placeId) renderSheet();

  // 업장마다 요청을 하나씩만 보낸다. 응답을 기다리는 동안 다시 누르면 마지막 값만 이어서 보낸다.
  // 요청이 동시에 나가면 도착 순서가 뒤바뀌어 시트에 이전 값이 남을 수 있기 때문이다
  state.desired = state.desired || {};
  state.desired[placeId] = local;
  sendStatus(placeId);
}

async function sendStatus(placeId) {
  state.inflight = state.inflight || {};
  if (state.inflight[placeId]) return;
  state.inflight[placeId] = true;
  let failure = null;
  while (state.desired[placeId]) {
    const job = state.desired[placeId];
    delete state.desired[placeId];
    try {
      const resp = await Backend.setStatus(placeId, job["진행상태"], job["재방문사유"] || undefined, job["재방문예정시각"] || undefined,
        job["진행상태"] === "관측완료" ? job["관리"] : undefined);
      state.confirmed[placeId] = { "진행상태": resp["진행상태"], "재방문사유": resp["재방문사유"] || "", "재방문예정시각": resp["재방문예정시각"] || "", "관리": resp["관리"] === true };
      failure = null;
    } catch (err) {
      failure = err;
    }
  }
  state.inflight[placeId] = false;
  delete state.pending[placeId];
  delete state.localValues[placeId];

  const p = state.byId[placeId];
  if (!p) return;
  // 마지막 요청 결과를 따른다. 실패면 서버에 반영된 마지막 값으로 되돌린다
  Object.assign(p, state.confirmed[placeId]);
  if (failure) toast(`${p.displayName} 상태를 저장하지 못해 되돌렸습니다. ${failure.message}`);
  else saveMapCache(state.fetchedAt);
  paintMarker(placeId);
  renderCounts();
  if (state.selected === placeId) renderSheet();
}

/* ---------------- 임의 핀 ---------------- */

function initLongPress() {
  const el = $("map");
  let timer = null, startX = 0, startY = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return cancel();
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const rect = el.getBoundingClientRect();
      const point = new kakao.maps.Point(startX - rect.left, startY - rect.top);
      const latLng = state.map.getProjection().coordsFromContainerPoint(point);
      if (navigator.vibrate) navigator.vibrate(30);
      openPinSheet(latLng.getLat(), latLng.getLng());
    }, LONG_PRESS_MS);
  }, { passive: true });
  el.addEventListener("touchmove", e => {
    const t = e.touches[0];
    if (!timer || !t) return;
    if (Math.hypot(t.clientX - startX, t.clientY - startY) > 12) cancel();
  }, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
}

let pinPreview = null;
function openPinSheet(lat, lng) {
  closeSheet();
  if (pinPreview) pinPreview.setMap(null);
  const dot = document.createElement("div");
  dot.className = "pin-preview";
  pinPreview = new kakao.maps.CustomOverlay({ map: state.map, position: new kakao.maps.LatLng(lat, lng), content: dot, zIndex: 8 });
  $("pinSheet").innerHTML = `
    <div class="s-head"><h3>업장 추가</h3><button class="x" id="closePin" aria-label="닫기">✕</button></div>
    <label class="time">상호명 <input id="pinName" type="text" autocomplete="off" placeholder="간판에 적힌 이름"></label>
    <div class="row">
      <button id="cancelPin" class="secondary">취소</button>
      <button id="okPin" class="primary">추가</button>
    </div>`;
  $("pinSheet").hidden = false;
  const close = () => { $("pinSheet").hidden = true; if (pinPreview) { pinPreview.setMap(null); pinPreview = null; } };
  $("closePin").onclick = close;
  $("cancelPin").onclick = close;
  $("okPin").onclick = () => {
    const name = $("pinName").value.trim();
    if (!name) return toast("상호명을 입력하세요");
    close();
    addPin(name, lat, lng);
  };
  setTimeout(() => $("pinName").focus(), 50);
}

async function addPin(name, lat, lng, kakao) {
  const tempId = `TMP${Date.now()}`;
  const temp = decorate({ place_id: tempId, "상호명": name, lat, lng, "진행상태": "미방문" });
  state.places.push(temp);
  state.byId[tempId] = temp;
  state.pending[tempId] = ++state.seq;
  addMarker(temp);
  renderCounts();
  try {
    const resp = await Backend.addPlace(name, lat, lng, kakao);
    removePlace(tempId);
    if (resp.duplicate && state.byId[resp.place.place_id]) {
      toast(`${name}은(는) 이미 명단에 있습니다`);
      if (kakao) focusPlace(resp.place.place_id);
      renderCounts();
      return;
    }
    const place = decorate({ ...resp.place, lat: Number(resp.place.lat), lng: Number(resp.place.lng) });
    state.places.push(place);
    state.byId[place.place_id] = place;
    state.confirmed[place.place_id] = pick(place);
    addMarker(place);
    saveMapCache(state.fetchedAt);
    toast(`${name} 추가 완료${place.zone_id ? ` (${place.zone_id})` : " (구역 밖)"}`);
    if (kakao) focusPlace(place.place_id);
  } catch (err) {
    removePlace(tempId);
    toast(`${name}을(를) 추가하지 못했습니다. ${err.message}`);
  }
  renderCounts();
}

function removePlace(placeId) {
  if (state.overlays[placeId]) state.overlays[placeId].overlay.setMap(null);
  delete state.overlays[placeId];
  delete state.byId[placeId];
  delete state.pending[placeId];
  state.places = state.places.filter(p => p.place_id !== placeId);
  if (state.selected === placeId) closeSheet();
}

/* ---------------- 현재 위치, 따라가기, 이동 경로 ---------------- */

function startTracking() {
  state.wantTracking = true;
  if (state.watchId !== null || !navigator.geolocation) return;
  state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true, maximumAge: 3000, timeout: 20000,
  });
}

function stopTracking() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
  state.me = { lat, lng, accuracy };
  if (heading !== null && !isNaN(heading) && speed > 0.5) state.heading = heading;
  drawMe();
  if (state.follow) state.map.setCenter(new kakao.maps.LatLng(lat, lng));
  if (accuracy <= TRACK_MAX_ACCURACY) addTrackPoint(lat, lng, pos.timestamp || Date.now());
  $("locBtn").classList.remove("error");
}

function onPositionError(err) {
  $("locBtn").classList.add("error");
  if (err.code === 1) toast("위치 권한이 없습니다. 설정에서 사파리 위치 접근을 허용하세요");
}

function drawMe() {
  if (!state.me) return;
  const pos = new kakao.maps.LatLng(state.me.lat, state.me.lng);
  if (!state.meOverlay) {
    const el = document.createElement("div");
    el.className = "me";
    el.innerHTML = `<span class="cone"></span><span class="dot"></span>`;
    state.meOverlay = new kakao.maps.CustomOverlay({ map: state.map, position: pos, content: el, zIndex: 10 });
    state.meEl = el;
  } else {
    state.meOverlay.setPosition(pos);
  }
  const cone = state.meEl.querySelector(".cone");
  cone.hidden = state.heading === null;
  if (state.heading !== null) cone.style.transform = `rotate(${state.heading}deg)`;
}

function setFollow(on) {
  state.follow = on;
  $("locBtn").classList.toggle("on", on);
}

async function onLocButton() {
  // 아이폰은 나침(방향) 권한을 사용자가 누른 순간에만 요청할 수 있다
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function" && !state.orientationAsked) {
    state.orientationAsked = true;
    try {
      if (await DeviceOrientationEvent.requestPermission() === "granted") {
        window.addEventListener("deviceorientation", e => {
          if (typeof e.webkitCompassHeading === "number") { state.heading = e.webkitCompassHeading; drawMe(); }
        });
      }
    } catch (e) { /* 방향 표시 없이 위치만 쓴다 */ }
  }
  startTracking();
  setFollow(true);
  if (state.me) state.map.setCenter(new kakao.maps.LatLng(state.me.lat, state.me.lng));
  else toast("현재 위치를 찾는 중입니다");
}

function addTrackPoint(lat, lng, t) {
  const last = state.track[state.track.length - 1];
  if (last) {
    const moved = distanceM(last.lat, last.lng, lat, lng);
    if (moved < TRACK_MIN_METERS && (t - last.t) / 1000 < TRACK_MIN_SECONDS) return;
  }
  state.track.push({ lat, lng, t });
  Store.set(TRACK_KEY, JSON.stringify(state.track));
  drawTrack();
}

function drawTrack() {
  const path = state.track.map(p => new kakao.maps.LatLng(p.lat, p.lng));
  if (!state.trackLine) {
    state.trackLine = new kakao.maps.Polyline({ map: state.map, path, strokeWeight: 4, strokeColor: "#1c7ed6", strokeOpacity: 0.75 });
  } else {
    state.trackLine.setPath(path);
  }
}

function resetTrack() {
  if (!confirm("지나온 경로를 지울까요?")) return;
  const last = state.track[state.track.length - 1];
  state.track = [];
  Store.set(TRACK_KEY, "[]");
  drawTrack();
  if (last) toast("경로를 지웠습니다");
}

function distanceM(lat1, lng1, lat2, lng2) {
  const r = 6371000, toRad = d => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// 개발용: 위치를 흉내 낸다
window.__simulatePosition = (lat, lng, accuracy = 10, t = Date.now()) =>
  onPosition({ coords: { latitude: lat, longitude: lng, accuracy, heading: null, speed: null }, timestamp: t });

/* ---------------- 업장 검색: 명단 먼저, 없으면 카카오에서 구역 안만 ---------------- */

const SEARCH_LOCAL_MAX = 20;
const KAKAO_MAX_PAGES = 3;          // 카카오 키워드 검색은 한 페이지 15건. 최대 45건까지 본다
// 구역 폴리곤 밖이지만 카카오 검색을 허용하는 곳. 지도에 구역은 그리지 않는다
const EXTRA_SEARCH_AREAS = [
  { name: "신설동", lat: 37.5760299683175, lng: 127.024456700382, radius: 700 },   // 신설동역 1호선. 9월 18일 추가
];
const search = { timer: null, query: "", kakao: null, kakaoQuery: "", kakaoLoading: false, kakaoError: "" };

// 검색에 카카오 장소 검색(services) 라이브러리가 필요하다. 준비 모드와 같이 쓰는 common.js는 건드리지 않고 여기서 불러온다
function loadKakaoWithServices(appKey) {
  return new Promise((resolve, reject) => {
    if (window.kakao && kakao.maps && kakao.maps.services) return resolve();
    if (!appKey) return reject(new Error("설정에서 카카오 JS 키를 입력하세요"));
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false&libraries=services`;
    s.onload = () => window.kakao ? kakao.maps.load(resolve) : reject(new Error("카카오 지도를 불러오지 못했습니다"));
    s.onerror = () => reject(new Error("카카오 지도를 불러오지 못했습니다. JS 키와 도메인 등록을 확인하세요"));
    document.head.appendChild(s);
  });
}

const squash = v => String(v || "").replace(/\s+/g, "").toLowerCase();

function zoneOfPoint(lng, lat) {
  for (const z of state.zones) {
    if (z.geometry && z.geometry.coordinates.some(poly => pointInRing(lng, lat, poly[0]))) return String(z.zone_id);
  }
  return "";
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function zonesBounds() {
  const b = new kakao.maps.LatLngBounds();
  state.zones.forEach(z => z.geometry && z.geometry.coordinates.forEach(poly =>
    poly[0].forEach(([lng, lat]) => b.extend(new kakao.maps.LatLng(lat, lng)))));
  return b;
}

function initSearch() {
  $("q").addEventListener("input", () => {
    clearTimeout(search.timer);
    search.timer = setTimeout(runSearch, 250);
  });
  $("q").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(search.timer);
    runSearch(true);
    $("q").blur();
  });
  $("q").addEventListener("focus", () => { if ($("q").value.trim()) renderSearch(); });
  $("clearQ").onclick = () => { $("q").value = ""; search.query = ""; $("clearQ").hidden = true; closeSearch(); };
}

function localMatches(query) {
  const key = squash(query);
  if (!key) return [];
  return state.places
    .filter(p => !String(p.place_id).startsWith("TMP") && squash(p["상호명"]).includes(key))
    .sort((a, b) => Number(!squash(a["상호명"]).startsWith(key)) - Number(!squash(b["상호명"]).startsWith(key))
      || String(a["상호명"]).localeCompare(String(b["상호명"])))
    .slice(0, SEARCH_LOCAL_MAX);
}

function runSearch(forceKakao) {
  const query = $("q").value.trim();
  search.query = query;
  $("clearQ").hidden = !query;
  if (!query) return closeSearch();
  if (search.kakaoQuery !== query) { search.kakao = null; search.kakaoError = ""; }
  const local = localMatches(query);
  // 명단에 없으면 카카오에서 자동으로 찾는다. 두 글자 이상일 때만
  if ((local.length === 0 && squash(query).length >= 2) || forceKakao === true) return searchKakao(query);
  renderSearch();
}

function searchKakao(query) {
  if (search.kakaoQuery === query && (search.kakaoLoading || search.kakao)) return renderSearch();
  search.kakaoQuery = query;
  search.kakaoLoading = true;
  search.kakaoError = "";
  search.kakao = null;
  const listed = new Set(state.places.map(p => String(p.kakao_id || "")).filter(Boolean));
  const found = new Map();
  // 구역 전체를 감싸는 사각형 한 번, 추가 검색 지역마다 반경으로 한 번씩 찾는다
  const areas = [{ bounds: zonesBounds() }, ...EXTRA_SEARCH_AREAS.map(a => ({ location: new kakao.maps.LatLng(a.lat, a.lng), radius: a.radius }))];
  const places = new kakao.maps.services.Places();

  const runArea = i => {
    if (i >= areas.length) {
      search.kakao = [...found.values()];
      search.kakaoLoading = false;
      return renderSearch();
    }
    let page = 0;
    const onResult = (data, status, pagination) => {
      if (search.kakaoQuery !== query) return; // 그 사이 검색어가 바뀜
      if (status === kakao.maps.services.Status.ERROR) {
        search.kakaoLoading = false;
        search.kakaoError = "카카오 검색에 실패했습니다. 통신 상태를 확인하세요";
        return renderSearch();
      }
      (data || []).forEach(d => {
        const lat = Number(d.y), lng = Number(d.x);
        const zone = searchAreaOf(lng, lat);
        if (!zone || listed.has(String(d.id)) || found.has(String(d.id))) return; // 범위 밖이거나 이미 명단에 있는 업장은 뺀다
        found.set(String(d.id), { id: String(d.id), name: d.place_name, lat, lng, zone, category: d.category_name,
                                  address: d.road_address_name || d.address_name, url: d.place_url });
      });
      page++;
      if (pagination && pagination.hasNextPage && page < KAKAO_MAX_PAGES) return pagination.nextPage();
      runArea(i + 1);
    };
    places.keywordSearch(query, onResult, { ...areas[i], size: 15 });
  };
  runArea(0);
  renderSearch();
}

// 구역 안이면 zone_id, 추가 검색 지역 반경 안이면 지역 이름, 둘 다 아니면 빈 문자열
function searchAreaOf(lng, lat) {
  const zone = zoneOfPoint(lng, lat);
  if (zone) return zone;
  const area = EXTRA_SEARCH_AREAS.find(a => distanceM(a.lat, a.lng, lat, lng) <= a.radius);
  return area ? area.name : "";
}

function renderSearch() {
  const query = search.query;
  if (!query) return closeSearch();
  const local = localMatches(query);
  const box = $("searchResults");
  const localHtml = local.length
    ? local.map(p => `<li><button class="r-item" data-local="${esc(p.place_id)}">
        <i style="background:${STATUS_COLOR[appStatus(p)]}"></i>
        <span class="r-name">${esc(p.displayName)}</span><small>${esc(p.zone_id || "구역 밖")} / ${esc(appStatus(p))}</small></button></li>`).join("")
    : `<li class="r-empty">명단에 없습니다</li>`;

  let kakaoHtml;
  if (search.kakaoLoading && search.kakaoQuery === query) {
    kakaoHtml = `<li class="r-empty">카카오에서 찾는 중</li>`;
  } else if (search.kakaoError && search.kakaoQuery === query) {
    kakaoHtml = `<li class="r-empty warn">${esc(search.kakaoError)}</li>`;
  } else if (search.kakao && search.kakaoQuery === query) {
    kakaoHtml = search.kakao.length
      ? search.kakao.map((k, i) => `<li><button class="r-item" data-kakao="${i}">
          <span class="plus">추가</span><span class="r-name">${esc(k.name)}</span>
          <small>${esc(k.zone)} / ${esc(String(k.category || "").split(">").slice(1).map(x => x.trim()).join(" > "))}</small>
          <small class="r-addr">${esc(k.address || "")}</small></button></li>`).join("")
      : `<li class="r-empty">검색 범위 안에서 명단에 없는 카카오 업장이 없습니다</li>`;
  } else {
    kakaoHtml = `<li><button class="r-more" id="kakaoMore">명단에 없나요? 카카오에서 찾기</button></li>`;
  }

  box.innerHTML = `<p class="r-head">명단</p><ul>${localHtml}</ul>
    <p class="r-head">카카오 (구역 안과 ${EXTRA_SEARCH_AREAS.map(a => a.name).join(", ")} 근처, 명단에 없는 업장)</p><ul>${kakaoHtml}</ul>`;
  box.hidden = false;
  box.querySelectorAll("[data-local]").forEach(b => b.onclick = () => { closeSearch(); focusPlace(b.dataset.local); });
  box.querySelectorAll("[data-kakao]").forEach(b => b.onclick = () => {
    const k = search.kakao[+b.dataset.kakao];
    if (!confirm(`${k.name}\n${k.address || ""}\n\n명단에 추가할까요?`)) return;
    closeSearch();
    search.kakao = null;
    search.kakaoQuery = "";
    addPin(k.name, k.lat, k.lng, { id: k.id, category: k.category, address: k.address, url: k.url });
  });
  if ($("kakaoMore")) $("kakaoMore").onclick = () => searchKakao(query);
}

function closeSearch() {
  $("searchResults").hidden = true;
}

function focusPlace(placeId) {
  const p = state.byId[placeId];
  if (!p) return;
  setFollow(false);
  if (state.map.getLevel() > 2) state.map.setLevel(2);
  state.map.setCenter(new kakao.maps.LatLng(p.lat, p.lng));
  updateMarkerVisibility();
  openSheet(placeId);
}

/* ---------------- 블로그 노출 목록 ---------------- */

// 지도와 연결하지 않는 읽기 전용 목록이다. 시트 "블로그 노출" 탭을 그대로 보여준다
function openList() {
  const rows = state.blogRank;
  $("listBody").innerHTML = rows.length
    ? rows.map(r => `<li class="li-item">
        <span class="li-rank">${esc(r["순위"])}</span>
        <span class="li-name">${esc(r["상호명"])}</span>
        <span class="li-num">${esc(r["보정노출"])}</span>
        <span class="li-addr">${esc(r["주소"] || "")}</span>
        <span class="li-meta">${esc(r["채택"] || "")}${r["광고글"] ? ` / 광고 ${esc(r["광고글"])}` : ""}${r["최근글"] ? ` / 최근 ${esc(r["최근글"])}` : ""}</span>
      </li>`).join("")
    : `<li class="r-empty">목록이 비어 있습니다. 시트 "블로그 노출" 탭을 확인하세요</li>`;
  $("listCount").textContent = rows.length ? `${rows.length}곳` : "";
  $("listModal").hidden = false;
}

/* ---------------- 설정, 알림, 시작 ---------------- */

function openSettings(message) {
  const s = Store.settings();
  $("setUrl").value = s.url;
  $("setToken").value = s.token;
  $("setKakao").value = s.kakao;
  $("settingsMsg").textContent = message || "";
  $("settings").hidden = false;
}

let toastTimer;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3500);
}

async function start() {
  $("resetTrack").onclick = resetTrack;
  $("openSettings").onclick = () => openSettings();
  $("closeSettings").onclick = () => ($("settings").hidden = true);
  $("saveSettings").onclick = () => {
    Store.saveSettings({ url: $("setUrl").value, token: $("setToken").value, kakao: $("setKakao").value });
    location.reload();
  };
  $("locBtn").onclick = onLocButton;
  $("openList").onclick = openList;
  $("closeList").onclick = () => ($("listModal").hidden = true);
  initSearch();
  // 앱을 백그라운드로 보내면 위치 추적을 멈춘다. 돌아오면 다시 켠다
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTracking();
    else if (state.wantTracking) startTracking();
  });

  const s = Store.settings();
  if (!fixtureMode && (!s.url || !s.token || !s.kakao)) return openSettings("처음 한 번 설정이 필요합니다.");
  try {
    await loadKakaoWithServices(s.kakao);
  } catch (err) {
    return openSettings(err.message);
  }
  initMap();

  try { state.track = JSON.parse(localStorage.getItem(TRACK_KEY)) || []; } catch (e) { state.track = []; }
  drawTrack();

  // 기기에 보관한 지도가 있으면 먼저 보여주고, 최신 데이터는 뒤에서 받는다
  let cached = null;
  try { cached = fixtureMode ? null : JSON.parse(localStorage.getItem(MAP_CACHE_KEY)); } catch (e) { cached = null; }
  if (cached) {
    state.fetchedAt = cached.fetchedAt;
    applyData(cached.data);
    drawZones();
    rebuildMarkers();
    renderCounts();
  }
  try {
    const fresh = await Backend.mapData();
    state.fetchedAt = fresh.fetchedAt;
    applyData(fresh.data);
    if (!cached) drawZones();
    rebuildMarkers();
    renderCounts();
    if (state.selected && state.byId[state.selected]) renderSheet(false);
    if (!fixtureMode) saveMapCache(fresh.fetchedAt);
  } catch (err) {
    if (!cached) return openSettings("데이터를 받지 못했습니다: " + err.message);
    toast("최신 데이터를 받지 못해 기기에 보관한 지도를 보여줍니다");
  }
  startTracking();
}

start().catch(err => (window.showFatal ? showFatal(err.message || String(err)) : alert(err)));
