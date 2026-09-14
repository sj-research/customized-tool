// 현장 모드: 업장을 탭하고, 말하고, 칩으로 확인하고, 방문 결과를 골라 저장한다
// 통신이 끊기면 기기에 보관했다가 자동으로 다시 보낸다

const STATUS = {
  미조사: { color: "#e8590c", label: "미조사" },
  완료: { color: "#2b8a3e", label: "조사 완료" },
  재방문: { color: "#c2255c", label: "재방문 필요" },
  제외: { color: "#adb5bd", label: "제외" },
};
const VISIT_RESULTS = ["완료", "키맨부재", "브레이크타임", "영업전", "재방문필요"];
const EVIDENCE = ["E1 관측", "E2 추론", "E3 전언"];
const YNU = ["Y", "N", "미확인"];
const QUEUE_KEY = "cet.queue.v1";
const RETRY_MS = 30000;

const $ = id => document.getElementById(id);
const fixtureMode = !!new URLSearchParams(location.search).get("fixture");
// 구조화와 저장을 보내는 곳. 개발용 데이터로 열면 가짜 응답을 쓴다
const Backend = {
  structure: (placeId, text) => (fixtureMode ? devStructure(text) : Api.structure(placeId, text)),
  saveVisit: visit => (fixtureMode ? Promise.resolve(devSave(visit)) : Api.saveVisit(visit)),
};

const state = {
  data: null, fetchedAt: "",
  places: [], byId: {}, brands: { own: [], competitor: [], soju: [] },
  plan: null,
  map: null, overlays: {},
  current: null,          // 선택한 place_id
  draft: null,            // { visitedAt, text, structured, result, revisitTime, structureError }
  recording: false, rec: null,
};

/* ---------------- 데이터 ---------------- */

function buildModel() {
  const d = state.data;
  const obsBy = groupBy(d.observations, "place_id");
  const visitBy = groupBy(d.visits || [], "place_id");
  const actBy = groupBy(d.actions.filter(a => ["대기", "진행"].includes(a["상태"])), "place_id");
  const blogBy = Object.fromEntries((d.blog || []).map(b => [b.place_id, b]));
  const nameCount = d.places.reduce((acc, p) => ((acc[p["상호명"]] = (acc[p["상호명"]] || 0) + 1), acc), {});
  state.places = d.places.map(p => {
    const obs = (obsBy[p.place_id] || []).sort((a, b) => String(b["조사일시"]).localeCompare(String(a["조사일시"])));
    const visits = (visitBy[p.place_id] || []).sort((a, b) => String(b["방문일시"]).localeCompare(String(a["방문일시"])));
    return {
      ...p, obs, visits, actions: actBy[p.place_id] || [], blog: blogBy[p.place_id] || null,
      displayName: nameCount[p["상호명"]] > 1 ? `${p["상호명"]} (${p["주소"] || p["위치서술"] || p.zone_id})` : p["상호명"],
      hasCoord: typeof p.lat === "number" && typeof p.lng === "number",
      status: placeStatus(p, obs, visits),
    };
  });
  state.byId = Object.fromEntries(state.places.map(p => [p.place_id, p]));

  // 칩 수정에 보여줄 브랜드는 시트 사전 탭에 있는 것만 쓴다. 사전에 없는 브랜드는 구조화 결과에 나온 경우에만 보인다
  const dict = d["사전"] || [];
  const pick = kind => dict.filter(r => r["구분"] === kind).map(r => String(r["용어 또는 인식결과"]).replace(/\s*\(.*\)$/, ""));
  state.brands = { own: pick("자사 브랜드"), competitor: pick("경쟁 브랜드"), soju: pick("소주 및 기타") };

  const today = todayKST();
  const plans = (d.routing_plans || []).filter(r => r["날짜"] === today)
    .sort((a, b) => String(b["수정일시"]).localeCompare(String(a["수정일시"])));
  state.plan = plans[0] || null;
}

function placeStatus(p, obs, visits) {
  if (p["진행상태"] === "제외") return "제외";
  const latest = visits[0];
  if (p["진행상태"] === "재방문필요" || (latest && latest["방문 결과"] && latest["방문 결과"] !== "완료")) return "재방문";
  if (["관측완료", "상담완료"].includes(p["진행상태"]) || obs.length || visits.length) return "완료";
  return "미조사";
}

function groupBy(rows, key) {
  return rows.reduce((acc, r) => ((acc[r[key]] = acc[r[key]] || []).push(r), acc), {});
}

function planOrder() {
  if (!state.plan) return [];
  return String(state.plan["방문 순서"] || "").split(",").map(s => s.trim()).filter(id => state.byId[id]);
}

function nowKST() {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return f.format(new Date()).replace("T", " ").slice(0, 16);
}

/** 저장 결과를 기기에 보관한 데이터에 반영한다. 다음에 준비 모드를 열어도 바로 보인다 */
function applySaved(resp) {
  const d = state.data;
  if (resp.visit && !(d.visits || []).some(v => v.visit_id === resp.visit.visit_id)) (d.visits = d.visits || []).push(resp.visit);
  const place = d.places.find(p => p.place_id === (resp.visit && resp.visit.place_id));
  (resp.observations || []).forEach(o => d.observations.push({ ...o, "상호명": place ? place["상호명"] : "" }));
  if (place && resp.place_status) {
    place["진행상태"] = resp.place_status;
    if (!place["최초조사일"] && resp.visit) place["최초조사일"] = resp.visit["방문일시"].slice(0, 10);
  }
  Store.saveCache({ fetchedAt: state.fetchedAt, data: d });
  buildModel();
}

/* ---------------- 전송 대기열 ---------------- */

const Queue = {
  items() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; } },
  save(items) { Store.set(QUEUE_KEY, JSON.stringify(items)); renderQueueBadge(); },
  add(visit, error) { const items = this.items(); items.push({ visit, queuedAt: nowKST(), lastError: error || "", failed: false }); this.save(items); },
  flushing: false,
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    let items = this.items();
    try {
      for (const item of items.filter(i => !i.failed)) {
        try {
          const resp = await Backend.saveVisit(item.visit);
          applySaved(resp);
          items = this.items().filter(i => i.visit.client_id !== item.visit.client_id);
          this.save(items);
          toast(`대기 중이던 ${state.byId[item.visit.place_id] ? state.byId[item.visit.place_id].displayName : "방문"} 저장 완료`);
        } catch (err) {
          items = this.items();
          const target = items.find(i => i.visit.client_id === item.visit.client_id);
          if (target) { target.lastError = err.message; target.failed = !err.retryable; }
          this.save(items);
          if (err.retryable) break; // 통신이나 서버가 아직 안 되면 다음 기회에
        }
      }
    } finally {
      this.flushing = false;
      drawMarkers();
      renderPanel();
    }
  },
};

function renderQueueBadge() {
  const items = Queue.items();
  const failed = items.filter(i => i.failed).length;
  $("queueBtn").hidden = items.length === 0;
  $("queueBtn").textContent = failed ? `전송 실패 ${failed} / 대기 ${items.length - failed}` : `전송 대기 ${items.length}`;
  $("queueBtn").classList.toggle("bad", failed > 0);
}

function openQueue() {
  const items = Queue.items();
  $("queueList").innerHTML = items.length ? items.map((i, idx) => {
    const p = state.byId[i.visit.place_id];
    return `<li><b>${esc(p ? p.displayName : i.visit.place_id)}</b> ${esc(i.visit.result)} <small>${esc(i.queuedAt)}</small>
      <div class="${i.failed ? "warn" : "muted"} small">${i.failed ? "다시 보내도 저장되지 않는 오류: " : ""}${esc(i.lastError || "대기 중")}</div>
      ${i.failed ? `<button class="secondary small-btn" data-drop="${idx}">목록에서 지우기</button>` : ""}</li>`;
  }).join("") : `<li class="muted">대기 중인 전송이 없습니다</li>`;
  $("queueList").querySelectorAll("[data-drop]").forEach(b => b.onclick = () => {
    if (!confirm("이 방문 기록을 기기에서 지웁니다. 녹음 원문도 사라집니다. 지울까요?")) return;
    const all = Queue.items();
    all.splice(+b.dataset.drop, 1);
    Queue.save(all);
    openQueue();
  });
  $("queueModal").hidden = false;
}

/* ---------------- 지도 ---------------- */

function initMap() {
  state.map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(37.5685, 127.0085), level: 3 });
  state.map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
}

function drawMarkers() {
  if (!state.map) return;
  Object.values(state.overlays).forEach(o => o.setMap(null));
  state.overlays = {};
  const order = planOrder();
  state.places.filter(p => p.hasCoord).forEach(p => {
    const idx = order.indexOf(p.place_id);
    const el = document.createElement("button");
    el.className = "mk" + (idx >= 0 ? " in-route" : " off-route") + (p.place_id === state.current ? " selected" : "");
    el.style.background = STATUS[p.status].color;
    el.innerHTML = idx >= 0 ? `<span class="no">${idx + 1}</span>` : "";
    el.title = p.displayName;
    el.onclick = e => { e.stopPropagation(); selectPlace(p.place_id); };
    state.overlays[p.place_id] = new kakao.maps.CustomOverlay({
      map: state.map, position: new kakao.maps.LatLng(p.lat, p.lng), content: el, clickable: true,
      zIndex: p.place_id === state.current ? 9 : idx >= 0 ? 5 : 2,
    });
  });
}

/* ---------------- 패널 ---------------- */

function renderPanel() {
  if (state.current) return renderPlace();
  const order = planOrder();
  const today = todayKST();
  $("panel").innerHTML = `
    <div class="p-head"><b>오늘 경로</b> <small class="muted">${esc(state.plan ? state.plan.plan_id : "저장된 계획 없음")}</small></div>
    ${order.length ? `<ol class="route">${order.map((id, i) => {
      const p = state.byId[id];
      const visitedToday = p.visits.find(v => String(v["방문일시"]).startsWith(today));
      return `<li><button data-id="${esc(id)}"><span class="no" style="background:${STATUS[p.status].color}">${i + 1}</span>
        <span class="nm">${esc(p.displayName)}</span>
        <small>${visitedToday ? esc(visitedToday["방문 결과"]) : p.hasCoord ? "" : "좌표 없음"}</small></button></li>`;
    }).join("")}</ol>` : `<p class="muted">오늘 날짜로 저장한 계획이 없습니다. 준비 모드에서 계획을 저장하거나, 지도에서 업장을 바로 탭하세요.</p>`}`;
  $("panel").querySelectorAll("[data-id]").forEach(b => b.onclick = () => selectPlace(b.dataset.id));
}

function selectPlace(placeId) {
  if (state.recording) return toast("녹음을 먼저 끝내세요");
  if (state.draft && state.current !== placeId && (state.draft.text || state.draft.structured)) {
    if (!confirm("저장하지 않은 기록이 있습니다. 다른 업장으로 넘어갈까요?")) return;
  }
  state.current = placeId;
  state.draft = { visitedAt: "", text: "", structured: null, result: "", revisitTime: "", structureError: "", busy: false };
  const p = state.byId[placeId];
  if (p.hasCoord) state.map.panTo(new kakao.maps.LatLng(p.lat, p.lng));
  drawMarkers();
  renderPlace();
}

function closePlace() {
  if (state.recording) return toast("녹음을 먼저 끝내세요");
  if (state.draft && (state.draft.text || state.draft.structured) && !confirm("저장하지 않은 기록이 사라집니다. 닫을까요?")) return;
  state.current = null;
  state.draft = null;
  drawMarkers();
  renderPanel();
}

function renderPlace() {
  const p = state.byId[state.current];
  const dr = state.draft;
  const lastObs = p.obs[0];
  const blog = p.blog && p.blog["상호명검색 일치 포스트 수"] !== null && p.blog["상호명검색 일치 포스트 수"] !== undefined
    ? `블로그 일치 ${esc(p.blog["상호명검색 일치 포스트 수"])}건, 최근 1년 ${esc(p.blog["상호명검색 최근1년 포스트 수"])}건` : "블로그 수치 없음";

  $("panel").innerHTML = `
    <div class="p-head">
      <button class="link back" id="back">‹ 경로</button>
      <b>${esc(p.displayName)}</b>
      <span class="pill" style="background:${STATUS[p.status].color}">${STATUS[p.status].label}</span>
    </div>
    <details class="brief" ${dr.text || dr.structured ? "" : "open"}>
      <summary>브리핑 요약</summary>
      <ul>
        ${p.actions.length ? p.actions.map(a => `<li><b>확인</b> ${esc(a["확인할내용"])}</li>`).join("") : `<li class="muted">미해결 액션 없음</li>`}
        <li><b>최근 관측</b> ${lastObs ? `${esc(lastObs["조사일시"])} ${esc(lastObs["특이사항"] || "")}` : "없음"}</li>
        <li class="muted">${blog}</li>
      </ul>
    </details>

    <button id="recBtn" class="rec ${state.recording ? "on" : ""}">${state.recording ? "녹음 끝내기" : dr.text ? "이어서 녹음" : "녹음 시작"}</button>
    <div id="interim" class="interim"></div>
    <label class="small muted">녹음 원문 (틀린 곳은 직접 고칠 수 있습니다)</label>
    <textarea id="text" rows="4" placeholder="녹음이 안 되면 여기에 적어도 됩니다">${esc(dr.text)}</textarea>
    <button id="structBtn" class="secondary" ${dr.busy || state.recording ? "disabled" : ""}>${dr.busy ? "구조화 중..." : dr.structured ? "다시 구조화" : "구조화"}</button>
    ${dr.structureError ? `<p class="warn">${esc(dr.structureError)}</p>` : ""}

    <div id="chips">${renderChips()}</div>

    <h4>방문 결과</h4>
    <div class="results">${VISIT_RESULTS.map(r => `<button class="res ${dr.result === r ? "on" : ""}" data-res="${r}">${r}</button>`).join("")}</div>
    ${dr.result && dr.result !== "완료" ? `<label class="small">재방문 희망 시각 <input id="revisit" type="text" value="${esc(dr.revisitTime)}" placeholder="예: 18:00, 사장님 6시 출근"></label>` : ""}

    <div class="actions-row">
      <button id="saveBtn" class="primary" ${dr.busy || state.recording ? "disabled" : ""}>저장</button>
    </div>`;

  $("back").onclick = closePlace;
  $("recBtn").onclick = toggleRecording;
  $("text").oninput = e => { dr.text = e.target.value; };
  $("structBtn").onclick = runStructure;
  $("panel").querySelectorAll("[data-res]").forEach(b => b.onclick = () => { dr.result = b.dataset.res; renderPlace(); });
  if ($("revisit")) $("revisit").oninput = e => { dr.revisitTime = e.target.value; };
  $("panel").querySelectorAll("[data-obs]").forEach(b => b.onclick = () => openChipEditor(+b.dataset.obs));
  $("saveBtn").onclick = saveDraft;
}

function renderChips() {
  const s = state.draft.structured;
  if (!s) return "";
  if (!s.observations.length) return `<p class="muted small">구조화된 관찰이 없습니다. 원문만 저장됩니다.</p>`;
  return s.observations.map((o, i) => {
    const draft = { Y: "O", N: "X", 미확인: "?" }[o.draft_beer];
    const brands = [...o.own_brands.map(b => `<span class="chip own">${esc(b)}</span>`), ...o.competitor_brands.map(b => `<span class="chip comp">${esc(b)}</span>`)];
    const pocm = o.pocm === "Y" ? `POCM ${o.pocm_brands.join(", ") || "있음"}` : o.pocm === "N" ? "POCM 없음" : "POCM ?";
    return `<button class="obs-row" data-obs="${i}">
      <span class="chip ev">${esc(o.evidence.replace(/^E\d /, ""))}</span>
      <span class="chip">생맥주 ${draft}</span>${brands.join("")}<span class="chip">${esc(pocm)}</span>
      <span class="note">${esc(o.note)}</span></button>`;
  }).join("") + `<p class="muted small">틀린 줄을 탭해서 고치세요.</p>`;
}

/* ---------------- 칩 수정 ---------------- */

function openChipEditor(i) {
  const o = state.draft.structured.observations[i];
  const toggles = (field, list) => {
    const all = [...new Set([...list, ...o[field]])];
    return all.map(b => `<button class="chip-t ${o[field].includes(b) ? "on" : ""}" data-field="${field}" data-val="${esc(b)}">${esc(b)}</button>`).join("");
  };
  const seg = (field, values) => values.map(v => `<button class="seg ${o[field] === v ? "on" : ""}" data-seg="${field}" data-val="${esc(v)}">${esc(v)}</button>`).join("");
  $("chipBody").innerHTML = `
    <h4>근거 유형</h4><div class="segs">${seg("evidence", EVIDENCE)}</div>
    <h4>생맥주</h4><div class="segs">${seg("draft_beer", YNU)}</div>
    <h4>자사 브랜드</h4><div class="toggles">${toggles("own_brands", state.brands.own)}</div>
    <h4>경쟁 브랜드</h4><div class="toggles">${toggles("competitor_brands", state.brands.competitor)}</div>
    <h4>POCM</h4><div class="segs">${seg("pocm", YNU)}</div>
    <div class="toggles">${toggles("pocm_brands", [...state.brands.own, ...state.brands.competitor, ...state.brands.soju])}</div>
    <h4>특이사항</h4><input id="noteEdit" type="text" value="${esc(o.note)}">
    <p class="muted small">원문발췌: ${esc(o.excerpt)}</p>
    <div class="actions-row">
      <button id="dropObs" class="secondary">이 관찰 빼기</button>
      <button id="doneObs" class="primary">완료</button>
    </div>`;
  $("chipBody").querySelectorAll("[data-seg]").forEach(b => b.onclick = () => { o[b.dataset.seg] = b.dataset.val; openChipEditor(i); });
  $("chipBody").querySelectorAll("[data-field]").forEach(b => b.onclick = () => {
    const arr = o[b.dataset.field];
    const k = arr.indexOf(b.dataset.val);
    k >= 0 ? arr.splice(k, 1) : arr.push(b.dataset.val);
    openChipEditor(i);
  });
  $("noteEdit").oninput = e => { o.note = e.target.value; };
  $("dropObs").onclick = () => {
    state.draft.structured.observations.splice(i, 1);
    $("chipModal").hidden = true;
    renderPlace();
  };
  $("doneObs").onclick = () => { $("chipModal").hidden = true; renderPlace(); };
  $("chipModal").hidden = false;
}

/* ---------------- 녹음 ---------------- */

function toggleRecording() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (state.recording) {
    state.recording = false;
    if (state.rec) state.rec.stop();
    return;
  }
  if (!SR) return toast("이 브라우저는 음성 인식을 지원하지 않습니다. 원문 칸에 적어 주세요");
  const dr = state.draft;
  if (!dr.visitedAt) dr.visitedAt = nowKST();
  state.recording = true;
  renderPlace();

  const start = () => {
    const rec = new SR();
    rec.lang = "ko-KR";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = e => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          dr.text = (dr.text ? dr.text + " " : "") + r[0].transcript.trim();
          if ($("text")) $("text").value = dr.text;
        } else {
          interim += r[0].transcript;
        }
      }
      if ($("interim")) $("interim").textContent = interim;
    };
    rec.onerror = e => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      state.recording = false;
      toast(`음성 인식 오류: ${e.error}. 원문 칸에 적어도 됩니다`);
    };
    rec.onend = () => {
      // 아이폰은 말이 끊기면 인식이 멈출 수 있다. 녹음 중이면 이어서 다시 시작한다
      if (state.recording) return start();
      state.rec = null;
      renderPlace();
      if (state.draft && state.draft.text.trim() && !state.draft.structured) runStructure();
    };
    state.rec = rec;
    try {
      rec.start();
    } catch (err) {
      state.recording = false;
      toast("녹음을 시작하지 못했습니다: " + err.message);
      renderPlace();
    }
  };
  start();
}

/* ---------------- 구조화와 저장 ---------------- */

async function runStructure() {
  const dr = state.draft;
  const placeId = state.current;
  if (!dr.text.trim()) return toast("녹음 원문이 비어 있습니다");
  dr.busy = true;
  dr.structureError = "";
  renderPlace();
  try {
    const resp = await Backend.structure(placeId, dr.text);
    if (state.current !== placeId) return;
    dr.structured = resp.structured;
    if (!dr.result && resp.structured.visit_result_hint) dr.result = resp.structured.visit_result_hint;
    if (!dr.revisitTime && resp.structured.revisit_time) dr.revisitTime = resp.structured.revisit_time;
  } catch (err) {
    dr.structureError = err.network || err.retryable
      ? "지금은 구조화할 수 없습니다. 방문 결과를 고르고 저장하면 원문을 보관했다가 연결되면 자동으로 구조화해 저장합니다."
      : `구조화 실패: ${err.message}`;
  } finally {
    dr.busy = false;
    if (state.current === placeId) renderPlace();
  }
}

async function saveDraft() {
  const dr = state.draft;
  const p = state.byId[state.current];
  if (!dr.result) return toast("방문 결과를 고르세요");
  if (!dr.text.trim() && !dr.structured) {
    if (!confirm("녹음 원문 없이 방문 결과만 저장할까요?")) return;
  }
  const visit = {
    client_id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    place_id: p.place_id, visited_at: dr.visitedAt || nowKST(), plan_id: state.plan ? state.plan.plan_id : "",
    result: dr.result, revisit_time: dr.result === "완료" ? "" : dr.revisitTime, text: dr.text.trim(),
    // 구조화 결과가 없으면 비워 보낸다. 원문이 있으면 서버가 저장 전에 구조화한다
    structured: dr.structured || (dr.text.trim() ? null : { observations: [] }),
  };
  dr.busy = true;
  renderPlace();
  try {
    const resp = await Backend.saveVisit(visit);
    applySaved(resp);
    toast(`${p.displayName} 저장 완료`);
  } catch (err) {
    if (err.network || err.retryable) {
      Queue.add(visit, err.message);
      toast("기기에 보관했습니다. 연결되면 자동으로 저장합니다");
    } else {
      dr.busy = false;
      renderPlace();
      return toast("저장 실패: " + err.message);
    }
  }
  state.current = null;
  state.draft = null;
  drawMarkers();
  renderPanel();
}

/* ---------------- 개발용 가짜 응답 (?fixture=) ---------------- */

async function devStructure(text) {
  await new Promise(r => setTimeout(r, 700));
  const has = w => text.includes(w);
  return { structured: {
    observations: [{
      method: "외부관측", evidence: "E1 관측", informant: null, draft_beer: has("생맥") ? "Y" : "미확인", bottle_beer: "미확인",
      own_brands: has("카스") ? ["카스"] : [], competitor_brands: has("테라") ? ["테라"] : [], soju_brands: [], other_drinks: [],
      nab_potential: null, pocm: /POCM|PC/.test(text) ? "Y" : "미확인", pocm_types: [], pocm_brands: has("테라") ? ["테라"] : [],
      pocm_location: null, pocm_density: null, stock_evidence: null, patio: null, crowd: null, waiting: null, age_groups: [],
      foreign_share: null, nationalities: [], note: "개발용 구조화 결과", excerpt: text.slice(0, 40),
    }],
    visit_result_hint: has("사장") ? "키맨부재" : null, revisit_time: has("6시") ? "18:00" : null,
  } };
}

function devSave(visit) {
  return {
    ok: true, visit: { visit_id: "V_DEV" + Date.now(), place_id: visit.place_id, "방문일시": visit.visited_at, "방문 결과": visit.result },
    observations: [], place_status: visit.result === "완료" ? "관측완료" : "재방문필요",
  };
}

/* ---------------- 시작 ---------------- */

let toastTimer;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3000);
}

async function loadData(fromServer) {
  const cached = Store.cached();
  let payload = !fromServer && !fixtureMode && cached ? cached : null;
  if (!payload) {
    $("dataInfo").textContent = "데이터 받는 중...";
    payload = await Api.loadData();
    if (!payload.fixture) Store.saveCache({ fetchedAt: payload.fetchedAt, data: payload.data });
  }
  state.data = payload.data;
  state.fetchedAt = payload.fetchedAt;
  $("dataInfo").textContent = `${payload.fixture ? "개발용 데이터" : "데이터"} ${payload.fetchedAt}`;
  buildModel();
}

async function start() {
  $("queueBtn").onclick = openQueue;
  $("closeQueue").onclick = () => ($("queueModal").hidden = true);
  $("retryQueue").onclick = () => { $("queueModal").hidden = true; Queue.flush(); };
  $("closeChip").onclick = () => { $("chipModal").hidden = true; renderPlace(); };
  $("refresh").onclick = async () => {
    if (state.draft && (state.draft.text || state.draft.structured)) return toast("기록을 저장하거나 닫은 뒤 새로고침하세요");
    try { await loadData(true); drawMarkers(); renderPanel(); toast("최신 데이터를 받았습니다"); }
    catch (err) { toast("새로고침 실패: " + err.message); }
  };
  window.addEventListener("online", () => Queue.flush());
  window.addEventListener("beforeunload", e => {
    if (state.draft && (state.draft.text || state.draft.structured)) { e.preventDefault(); e.returnValue = ""; }
  });
  renderQueueBadge();

  const s = Store.settings();
  if (!fixtureMode && (!s.url || !s.token || !s.kakao)) {
    $("panel").innerHTML = `<p class="warn">설정이 없습니다. <a href="prep.html">준비 모드</a>의 설정에서 URL, 토큰, 카카오 키를 먼저 입력하세요.</p>`;
    return;
  }
  await loadKakao(s.kakao);
  initMap();
  try {
    await loadData(false);
  } catch (err) {
    $("panel").innerHTML = `<p class="warn">데이터를 받지 못했습니다: ${esc(err.message)}</p>`;
    return;
  }
  drawMarkers();
  renderPanel();
  const order = planOrder();
  const first = order.map(id => state.byId[id]).find(p => p.hasCoord);
  if (first) state.map.setCenter(new kakao.maps.LatLng(first.lat, first.lng));
  Queue.flush();
  setInterval(() => { if (Queue.items().some(i => !i.failed)) Queue.flush(); }, RETRY_MS);
}

start().catch(err => (window.showFatal ? showFatal(err.message || String(err)) : alert(err)));
