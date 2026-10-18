// 격자 분석. 서울 생활인구 250m 격자를 내 zones, 행정동과 겹쳐 본다 (10월 17일)
// 데이터는 data/grid-analysis.json 한 파일에서 받는다. 시트 호출이 없다.
// 카카오 JS 키는 common.js 의 Store 에서 읽는다. 저장소에 넣지 않는다.

const VIEWS = { all: [37.5712, 127.0165, 5], ddm: [37.5690, 127.0092, 4], sin: [37.5752, 127.0245, 3] };
// 구역은 2026-10-18 2차 재구성. D1~D4, S1 다섯 개다.
// 옛 D4가 새 D1, 옛 D6이 새 D2, 옛 D1이 새 D3, 옛 D3이 새 D4다. 색을 따라 옮겼다.
const ZONE_COLOR = {
  D1: "#5f0f40", D2: "#1d3557", D3: "#c1121f", D4: "#0f7173", S1: "#6a4c93",
};
const DONG_COLOR = ["#e76f51", "#2a9d8f", "#264653", "#e9c46a", "#8ab17d", "#f4a261", "#6d597a", "#355070"];
const ZONE_ORDER = ["D2", "D4", "D1", "S1", "D3"];   // 외국인 비중 내림차순

const $ = id => document.getElementById(id);
const f1 = v => (v == null ? "-" : Number(v).toFixed(1));
const f2 = v => (v == null ? "-" : Number(v).toFixed(2));
const n0 = v => (v == null ? "-" : Math.round(v).toLocaleString());

let D = null, map = null;
const layers = { zones: [], grids: [], dongs: [], clusters: [], labels: [], lodging: [] };
const on = { zones: true, grids: true, dongs: false, clusters: false, labels: true, lodging: false };

// 숙박 분류. F 외국인 지향, M 여관 모텔, E 기타(판단 보류)
const LODGE = {
  F: { color: "#d00000", label: "외국인 지향" },
  M: { color: "#8d99ae", label: "여관, 모텔" },
  E: { color: "#ffffff", label: "기타" },
};

function fail(html) {
  $("error").style.display = "block";
  $("error").innerHTML = html;
}

/* ---------- 레이어 ---------- */

function drawGrids() {
  const K = kakao.maps;
  D.grids.forEach(g => {
    const poly = new K.Polygon({
      path: g.bounds.map(p => new K.LatLng(p[0], p[1])),
      strokeWeight: 1, strokeColor: D.color[g.part], strokeOpacity: .85,
      fillColor: D.color[g.part], fillOpacity: .28,
    });
    K.event.addListener(poly, "click", () => pickGrid(g));
    K.event.addListener(poly, "mouseover", () => poly.setOptions({ fillOpacity: .5 }));
    K.event.addListener(poly, "mouseout", () => poly.setOptions({ fillOpacity: .28 }));
    layers.grids.push(poly);
  });
}

function drawZones() {
  const K = kakao.maps;
  Object.entries(D.zones).forEach(([zid, z]) => {
    z.rings.forEach(ring => {
      layers.zones.push(new K.Polygon({
        path: ring.map(p => new K.LatLng(p[0], p[1])),
        strokeWeight: 3, strokeColor: ZONE_COLOR[zid], strokeOpacity: .95,
        fillColor: ZONE_COLOR[zid], fillOpacity: .05,
      }));
    });
    const c = centroid(z.rings[0]);
    layers.labels.push(new K.CustomOverlay({
      position: new K.LatLng(c[0], c[1]), yAnchor: .5, zIndex: 5,
      content: `<div class="lb" style="background:${ZONE_COLOR[zid]}">${zid} ${z.name}</div>`,
    }));
  });
}

function drawDongs() {
  const K = kakao.maps;
  Object.keys(D.dong_polys).sort().forEach((code, i) => {
    const col = DONG_COLOR[i % DONG_COLOR.length];
    D.dong_polys[code].forEach(ring => {
      const poly = new K.Polygon({
        path: ring.map(p => new K.LatLng(p[0], p[1])),
        strokeWeight: 4, strokeColor: col, strokeOpacity: .9, strokeStyle: "shortdash",
        fillColor: col, fillOpacity: .1,
      });
      K.event.addListener(poly, "click", () => pickDong(code));
      layers.dongs.push(poly);
    });
    const c = centroid(D.dong_polys[code][0]);
    layers.dongs.push(new K.CustomOverlay({
      position: new K.LatLng(c[0], c[1]), yAnchor: .5, zIndex: 4,
      content: `<div class="lb dg" style="border-color:${col};color:${col}">${D.names[code] || code}</div>`,
    }));
  });
}

function drawClusters() {
  const K = kakao.maps;
  Object.entries(D.clusters || {}).forEach(([nm, c]) => {
    c.rings.forEach(ring => {
      const poly = new K.Polygon({
        path: ring.map(p => new K.LatLng(p[0], p[1])),
        strokeWeight: 5, strokeColor: c.color, strokeOpacity: .95, strokeStyle: "longdash",
        fillColor: c.color, fillOpacity: .04,
      });
      K.event.addListener(poly, "click", () => pickCluster(nm));
      layers.clusters.push(poly);
    });
    const p = centroid(c.rings[0]);
    layers.clusters.push(new K.CustomOverlay({
      position: new K.LatLng(p[0], p[1]), yAnchor: 1.3, zIndex: 9,
      content: `<div class="lb big" style="background:${c.color}">${nm} 묶음 · 격자 ${c.ngrid}개<br>
        <span>외국인 ${f2(c.fo)}% · 단기÷장기 ${f2(c.sl)}</span></div>`,
    }));
  });
  const d = D.dropped;
  if (d && d.rings) {
    d.rings.forEach(ring => layers.clusters.push(new K.Polygon({
      path: ring.map(p => new K.LatLng(p[0], p[1])),
      strokeWeight: 3, strokeColor: d.color, strokeOpacity: .85, strokeStyle: "dot",
      fillColor: d.color, fillOpacity: .1,
    })));
    const p = centroid(d.rings[0]);
    layers.clusters.push(new K.CustomOverlay({
      position: new K.LatLng(p[0], p[1]), yAnchor: .5, zIndex: 8,
      content: `<div class="lb out">신설동 묶음에서 제외<br><span>격자 ${d.grids.length}개</span></div>`,
    }));
  }
}

function drawLodging() {
  const K = kakao.maps;
  (D.lodging || []).forEach(p => {
    const c = LODGE[p.g] || LODGE.E;
    const ov = new K.CustomOverlay({
      position: new K.LatLng(p.y, p.x), yAnchor: .5, xAnchor: .5, zIndex: 11,
      content: `<div class="ld ld-${p.g}" style="background:${c.color}" title="${p.n} (${p.k})"></div>`,
      clickable: true,
    });
    layers.lodging.push(ov);
  });
}

function lodgingTable() {
  const L = D.lodgingstat;
  if (!L) return "";
  const cl = Object.entries(L.clusters).map(([nm, c]) =>
    `<tr><td>${nm} <span class="dim">${c.grids}격자</span></td><td>${c.all}</td>
     <td><b>${c.F}</b></td><td>${c.M}</td><td>${c.E}</td>
     <td><b>${f2(c.dawn["단기"])}</b></td></tr>`).join("");
  const zs = ZONE_ORDER.map(z => {
    const r = L.zones[z]; if (!r) return "";
    return `<tr><td>${z}</td><td>${r.poly.all}</td><td><b>${r.poly.F}</b></td>
      <td>${r.poly.M}</td><td>${r.bbox.all}</td><td><b>${f2(r.dawn["단기"])}</b></td></tr>`;
  }).join("");
  return `<h2>숙박업소 <em>총 ${L.total}곳</em></h2>
    <table><thead><tr><th>묶음</th><th>전체</th><th>외국인<br>지향</th><th>여관<br>모텔</th><th>기타</th>
      <th>단기<br>새벽÷낮</th></tr></thead>
    <tbody>${cl}</tbody></table>
    <table style="margin-top:6px"><thead><tr><th>구역</th><th>폴리곤<br>전체</th><th>외국인<br>지향</th><th>여관<br>모텔</th><th>bbox<br>전체</th>
      <th>단기<br>새벽÷낮</th></tr></thead>
    <tbody>${zs}</tbody></table>
    <div class="dim" style="margin-top:6px">
      ${Object.entries(LODGE).map(([k, v]) =>
        `<span class="sw" style="display:inline-block;background:${v.color};border:1px solid #bbb;margin:0 3px 0 0"></span>${v.label}`).join(" ")}
      <br>새벽÷낮이 1을 넘으면 새벽(01~06시) 체류가 낮(11~14시)보다 많다는 뜻이다.
      <br>카카오 지도 등재 기준이다. 객실 수가 없어 업소 수만 쓴다. 에어비앤비는 빠져 있다.
      기타 ${L.clusters["동대문"].E + L.clusters["신설동"].E}곳은 업태와 상호로 판단이 안 돼 어느 쪽에도 넣지 않았다.</div>`;
}

function centroid(ring) {
  let la = 0, ln = 0;
  ring.forEach(p => { la += p[0]; ln += p[1]; });
  return [la / ring.length, ln / ring.length];
}

function applyLayers() {
  Object.keys(layers).forEach(k => {
    const show = k === "labels" ? on.labels : on[k];
    layers[k].forEach(o => o.setMap(show ? map : null));
  });
}

/* ---------- 패널 ---------- */

function buildTables() {
  const Z = D.zonestat || {};
  $("ztab").querySelector("tbody").innerHTML = ZONE_ORDER.filter(z => Z[z]).map(z => {
    const r = Z[z];
    return `<tr data-z="${z}" title="${r.name}"><td><span class="sw" style="display:inline-block;background:${ZONE_COLOR[z]};margin-right:4px"></span>${z}</td>
      <td>${r.ngrid}</td><td>${f2(r.fo)}%</td><td>${f2(r.sl)}</td><td>${f2(r.dawn)}</td></tr>`;
  }).join("") + Object.entries(D.clusters || {}).map(([nm, c]) =>
    `<tr class="sum"><td>${nm}</td><td>${c.ngrid}</td><td>${f2(c.fo)}%</td><td>${f2(c.sl)}</td><td>-</td></tr>`).join("");

  const S = D.dongstat || {};
  $("dtab").querySelector("tbody").innerHTML = Object.keys(S).sort((a, b) => S[b].fo - S[a].fo).map(d => {
    const r = S[d];
    return `<tr data-d="${d}"><td>${(D.names[d] || d).replace(/^\S+\s/, "")}</td>
      <td>${f1(r.fo)}%</td><td>${r.rank_fo}</td><td>${f2(r.sl)}</td><td>${r.rank_sl}</td></tr>`;
  }).join("");

  $("dtab").querySelectorAll("tr[data-d]").forEach(tr =>
    tr.addEventListener("click", () => pickDong(tr.dataset.d)));
  $("ldg").innerHTML = lodgingTable();
  $("meta").textContent = `${D.meta.period} · 공통 ${D.meta.slots.toLocaleString()}슬롯 · ${D.meta.note} · 갱신 ${D.meta.updated}`;
}

function bandTable(band) {
  if (!band) return "";
  const rows = ["내국인", "장기", "단기"].map(lab => {
    const b = band[lab]; if (!b) return "";
    const meal = (b["낮"] * 4 + b["저녁"] * 4) / 8;
    return `<tr><td>${lab}</td><td>${n0(b["낮"])}</td><td>${n0(b["저녁"])}</td>
      <td>${n0(b["심야"])}</td><td>${n0(b["새벽"])}</td>
      <td><b>${f2(b["새벽"] ? meal / b["새벽"] : 0)}</b></td>
      <td>${f2(b["낮"] ? b["저녁"] / b["낮"] : 0)}</td></tr>`;
  }).join("");
  return `<table style="font-size:10px;margin-top:4px"><thead><tr><th>집단</th>
    <th>낮<br><em>11~14</em></th><th>저녁<br><em>17~20</em></th><th>심야<br><em>21~00</em></th>
    <th>새벽<br><em>01~06</em></th><th>식사<br>÷새벽</th><th>저녁<br>÷낮</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pickGrid(g) {
  const Z = D.zonestat || {};
  const ovs = Object.entries(g.ov || {});
  const share = Object.entries(D.grid_share[g.code] || {});
  const zoneBlocks = ovs.map(([z]) => {
    const r = Z[z]; if (!r) return "";
    return `<div style="margin-top:9px;padding-top:7px;border-top:1px solid #eee">
      <div class="nm">${z} ${r.name}</div>
      <div class="dim">격자 ${r.ngrid}개 · 외국인 ${f2(r.fo)}% · 단기÷장기 ${f2(r.sl)}<br>내국인 ${f1(r.kp)}% / 장기 ${f1(r.lp)}% / 단기 ${f1(r.sp)}%<br>
      내국인 ${n0(r.k)} / 장기 ${n0(r.l)} / 단기 ${n0(r.s)}</div>${bandTable(r.band)}</div>`;
  }).join("");
  $("pick").innerHTML = `<div style="font-size:12px"><span class="nm">${g.code}</span>
      <span class="dim">${g.center[0].toFixed(5)}, ${g.center[1].toFixed(5)}</span></div>
    <div class="dim" style="margin:3px 0 6px">
      <span class="sw" style="display:inline-block;background:${D.color[g.part]};margin-right:4px"></span>${g.part}</div>
    ${ovs.length ? ovs.map(([z, v]) =>
      `<div class="row"><span class="sw" style="background:${ZONE_COLOR[z]}"></span>
       <span><span class="nm">${z} ${D.zones[z].name}</span><br>
       <span class="dim">격자 면적의 ${f1(v)}% 겹침</span></span></div>`).join("")
      : '<div class="dim">어느 zone 폴리곤에도 닿지 않는다. bbox 로만 걸린 격자다.</div>'}
    ${share.length ? `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #eee">
      <div class="dim" style="margin-bottom:3px">행정동 지분 <em>(내국인 인구 기준)</em></div>
      ${share.map(([d, v]) => `<div class="dim">${D.names[d] || d} <b>${Math.round(v * 100)}%</b></div>`).join("")}
      </div>` : ""}
    ${zoneBlocks}`;
}

function pickDong(code) {
  const r = (D.dongstat || {})[code];
  if (!r) { $("pick").innerHTML = '<span class="dim">대상 11개 행정동이 아니다.</span>'; return; }
  const nat = lab => {
    const a = r["nat_" + lab] || [];
    return a.length ? a.map(x => `${x.c} ${x.v}<span class="dim">(${x.m}%)</span>`).join(", ") : "-";
  };
  const ageRow = (sc, label) => {
    const a = (r.age || {})[sc]; if (!a) return "";
    const cell = k => `<td>${f1(a[k])}%<br><span class="dim">${a["rank_" + k]}위</span></td>`;
    return `<tr><td>${label}</td>${cell("20~34세")}${cell("35~49세")}${cell("50~64세")}${cell("65세이상")}
      <td><b>${f1(a.senior)}%<br><span class="dim">${a.rank_senior}위</span></b></td></tr>`;
  };
  const sm = (D.seoul_age || {}).ALL || {};
  $("pick").innerHTML = `<div style="font-size:12px"><span class="nm">${D.names[code] || code}</span>
      <span class="dim">${code}</span></div>
    <div class="dim" style="margin:3px 0 6px">내국인 ${n0(r.k)} / 장기 ${n0(r.l)} / 단기 ${n0(r.s)}</div>
    <table><tbody>
      <tr><td>외국인 비중 <em class="dim">(장+단)/전체</em></td><td><b>${f2(r.fo)}%</b></td><td>${r.rank_fo}위 / ${r.n}</td></tr>
      <tr><td>단기 비중 <em class="dim">단/전체</em></td><td><b>${f2(r.sw)}%</b></td><td>${r.rank_sw}위</td></tr>
      <tr><td>장기 비중 <em class="dim">장/전체</em></td><td><b>${f2(r.lw)}%</b></td><td></td></tr>
      <tr><td>단기÷장기 <em class="dim">단/장</em></td><td><b>${f2(r.sl)}</b></td><td>${r.rank_sl}위</td></tr>
    </tbody></table>
    <div style="margin-top:8px;font-size:10.5px">
      <div class="dim">단기 체류 상위 국적 <em>(마스킹률)</em></div>${nat("단기")}
      <div class="dim" style="margin-top:5px">장기 체류 상위 국적</div>${nat("장기")}</div>
    <div style="margin-top:9px">
      <div class="dim" style="margin-bottom:2px">내국인 연령 구성 · 서울 순위</div>
      <table style="font-size:9.5px"><thead><tr><th></th><th>20~34</th><th>35~49</th><th>50~64</th><th>65+</th><th>50+</th></tr></thead>
      <tbody>${ageRow("ALL", "전체")}${ageRow("저녁", "저녁")}${ageRow("심야", "심야")}</tbody></table>
      <div class="dim" style="font-size:9.5px;margin-top:3px">서울 중앙값: 20~34 ${sm["20~34세"]}% ·
        35~49 ${sm["35~49세"]}% · 50~64 ${sm["50~64세"]}% · 65+ ${sm["65세이상"]}%</div></div>`;
}

function pickCluster(nm) {
  const c = (D.clusters || {})[nm]; if (!c) return;
  $("pick").innerHTML = `<div style="font-size:12px"><span class="nm">${nm} 묶음</span>
      <span class="dim">격자 ${c.ngrid}개</span></div>
    <div class="dim" style="margin:3px 0 6px">내국인 ${n0(c.k)} / 장기 ${n0(c.l)} / 단기 ${n0(c.s)}</div>
    <table><tbody>
      <tr><td>외국인 비중</td><td><b>${f2(c.fo)}%</b></td></tr>
      <tr><td>단기÷장기</td><td><b>${f2(c.sl)}</b></td></tr>
      <tr><td colspan="2" class="dim" style="padding-top:6px">서울 427개 행정동 분포에 넣으면</td></tr>
      <tr><td>외국인 비중</td><td>${c.rank_fo}위 수준 <span class="dim">(상위 ${c.pct_fo}%)</span></td></tr>
      <tr><td>단기÷장기</td><td>${c.rank_sl}위 수준 <span class="dim">(상위 ${c.pct_sl}%)</span></td></tr>
    </tbody></table>
    <div class="dim" style="margin-top:7px">묶음은 격자 집합이고 비교 대상은 행정동이다. 단위가 달라 체감용이다.</div>`;
}

/* ---------- 시작 ---------- */

function wire() {
  $("layers").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const k = b.dataset.layer;
    on[k] = !on[k];
    b.classList.toggle("on", on[k]);
    applyLayers();
  });
  document.querySelectorAll(".views button").forEach(b =>
    b.addEventListener("click", () => {
      const [la, ln, lv] = VIEWS[b.dataset.view];
      map.setLevel(lv);
      map.setCenter(new kakao.maps.LatLng(la, ln));
    }));
  $("toggle").addEventListener("click", () => {
    document.body.classList.toggle("folded");
    $("toggle").textContent = document.body.classList.contains("folded") ? "◂" : "▸";
    setTimeout(() => map.relayout(), 220);
  });
}

async function main() {
  D = await fetch("data/grid-analysis.json?v=" + window.APP_VERSION).then(r => {
    if (!r.ok) throw new Error("데이터 파일을 불러오지 못했습니다 (" + r.status + ")");
    return r.json();
  });
  buildTables();

  const s = Store.settings();
  if (!s.kakao) {
    return fail('카카오 JS 키가 없습니다. <a href="field.html">현장 모드</a>에서 키를 먼저 넣으세요.'
      + '<br>키는 이 브라우저에만 저장되고 저장소에는 올라가지 않습니다.'
      + '<br><br>카카오 개발자 콘솔의 플랫폼 > Web 에 <b>https://sj-research.github.io</b> 등록이 필요합니다.');
  }
  try {
    await loadKakao(s.kakao);
  } catch (e) {
    return fail(e.message + '<br><br>카카오 개발자 콘솔의 플랫폼 > Web 에 '
      + '<b>https://sj-research.github.io</b> 가 등록되어 있는지 확인하세요.');
  }

  const [la, ln, lv] = VIEWS.all;
  map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(la, ln), level: lv });
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  drawGrids(); drawZones(); drawDongs(); drawClusters(); drawLodging();
  applyLayers();
  wire();
}
main();
