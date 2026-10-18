// 구역 변천 비교 (10월 18일). 발표 장표 "지도 3컷 병치"용으로 만든 화면이다.
// 세 시점을 같은 중심과 같은 축척으로 보여 주고, 탭만 바꿔 가며 캡처하면 3장이 그대로 맞는다.
// 구역 자료는 data/zone-versions.json에 박아 두었다. 업장 점만 시트에서 받는다.

// 세 시점 폴리곤 전체를 감싸는 범위로 맞춘다. 셋 다 같은 화면이라 캡처하면 그대로 겹친다
const STATIONS = [
  { name: "동대문역사문화공원역", lat: 37.56566, lng: 127.00900 },
  { name: "동대문역", lat: 37.57167, lng: 127.01063 },
  { name: "동묘앞역", lat: 37.57322, lng: 127.01636 },
  { name: "신설동역", lat: 37.57603, lng: 127.02446 },
];

const $ = id => document.getElementById(id);
let map = null, data = null, places = [], cur = "v3", homed = false;
const layers = { polys: [], labels: [], dots: [] };

const fail = html => { $("error").style.display = "block"; $("error").innerHTML = html; };
const clear = k => { layers[k].forEach(o => o.setMap(null)); layers[k] = []; };

function allBounds() {
  const b = new kakao.maps.LatLngBounds();
  data.versions.forEach(v => v.zones.forEach(z => z.rings.forEach(r =>
    r.forEach(([x, y]) => b.extend(new kakao.maps.LatLng(y, x))))));
  return b;
}

function setView() {
  map.relayout();
  map.setBounds(allBounds(), 70, 70, 110, 70);   // 아래는 수치 띠를 피해 더 띄운다
}

function initMap() {
  map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(37.5715, 127.015), level: 5 });
  window.__prep = { map, setView, render };   // 캡처할 때 밖에서 부르려고 열어 둔다
  // 창이 가려진 채 열리면 지도 크기가 0으로 잡혀 위치가 어긋난다
  new ResizeObserver(() => { if ($("map").clientWidth) { setView(); homed = true; } })
    .observe($("map"));
  STATIONS.forEach(s => new kakao.maps.CustomOverlay({
    map, position: new kakao.maps.LatLng(s.lat, s.lng), yAnchor: 1.6, zIndex: 6,
    content: `<div class="station">${esc(s.name)}</div>`,
  }));
}

// 구역 이름은 그 구역 꼭짓점 평균에 단다
function center(rings) {
  const pts = rings.flat();
  return [pts.reduce((a, p) => a + p[1], 0) / pts.length, pts.reduce((a, p) => a + p[0], 0) / pts.length];
}

function render(key) {
  cur = key;
  const v = data.versions.find(x => x.key === key);
  document.querySelectorAll("[data-v]").forEach(b => b.classList.toggle("on", b.dataset.v === key));
  $("vTitle").textContent = v.title;
  $("vDate").textContent = v.date;
  $("vWhy").textContent = v.why;
  $("sZones").textContent = v.zones.length;
  $("sIn").textContent = v.inside;
  $("sOut").textContent = v.outside;
  $("sTotal").textContent = v.total;

  clear("polys"); clear("labels");
  v.zones.forEach(z => {
    z.rings.forEach(ring => {
      layers.polys.push(new kakao.maps.Polygon({
        map, path: ring.map(([x, y]) => new kakao.maps.LatLng(y, x)),
        strokeWeight: 3, strokeColor: z.color, strokeOpacity: 0.95, fillColor: z.color, fillOpacity: 0.22,
      }));
    });
    if (!z.rings.length) return;
    const [la, ln] = center(z.rings);
    layers.labels.push(new kakao.maps.CustomOverlay({
      map, position: new kakao.maps.LatLng(la, ln), zIndex: 7,
      content: `<div class="zlabel" style="border-color:${z.color};color:${z.color}">${esc(z.id)}</div>`,
    }));
  });
  $("legend").innerHTML = v.zones.map(z =>
    `<div><span class="chip" style="background:${z.color}"></span>${esc(z.id)} ${esc(z.name)} <b>${z.count}</b></div>`).join("");
}

function drawPlaces() {
  clear("dots");
  places.forEach(p => {
    const el = document.createElement("div");
    el.className = "pdot";
    layers.dots.push(new kakao.maps.CustomOverlay({
      map, content: el, zIndex: 3, position: new kakao.maps.LatLng(+p.lat, +p.lng),
    }));
  });
}

async function start() {
  try {
    data = await fetch("data/zone-versions.json?v=" + window.APP_VERSION).then(r => r.json());
  } catch (e) {
    return fail("구역 자료를 읽지 못했습니다 (data/zone-versions.json)");
  }
  const s = Store.settings();
  if (!s.kakao) {
    return fail('설정이 비어 있습니다. <a href="field.html">현장 모드</a>에서 카카오 JS 키를 먼저 넣으세요.');
  }
  try {
    await loadKakao(s.kakao);
  } catch (err) {
    return fail(esc(err.message));
  }
  initMap();
  document.querySelectorAll("[data-v]").forEach(b => b.onclick = () => render(b.dataset.v));
  render(cur);
  // 업장 점은 있으면 좋고 없어도 구역 비교는 된다
  if (s.url && s.token) {
    try {
      const body = await Api.call("mapData");
      places = (body.data.places || []).filter(p => p["진행상태"] !== "삭제" && p.lat !== "" && p.lat !== null);
      drawPlaces();
    } catch (e) { /* 업장 점 없이 그대로 보여 준다 */ }
  }
}

start();
