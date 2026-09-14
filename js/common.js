// 공통: 설정, API 호출, 데이터 보관, 표시용 도우미
// 설정값(Apps Script URL, 토큰, 카카오 JS 키)은 기기 브라우저에만 저장한다. 코드와 저장소에 넣지 않는다

const SETTINGS_KEYS = { url: "cet.apiUrl", token: "cet.apiToken", kakao: "cet.kakaoJsKey" };
const CACHE_KEY = "cet.data.v1";

const Store = {
  get(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } },
  settings() {
    return { url: this.get(SETTINGS_KEYS.url), token: this.get(SETTINGS_KEYS.token), kakao: this.get(SETTINGS_KEYS.kakao) };
  },
  saveSettings(s) {
    this.set(SETTINGS_KEYS.url, s.url.trim());
    this.set(SETTINGS_KEYS.token, s.token.trim());
    this.set(SETTINGS_KEYS.kakao, s.kakao.trim());
  },
  cached() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { return null; }
  },
  saveCache(payload) { return this.set(CACHE_KEY, JSON.stringify(payload)); },
};

const Api = {
  async call(action, extra = {}) {
    const { url, token } = Store.settings();
    if (!url || !token) throw new Error("설정에서 Apps Script URL과 토큰을 입력하세요");
    let body;
    try {
      // Content-Type 헤더를 붙이지 않는다. 브라우저 사전 요청 없이 보내기 위해서다
      const res = await fetch(url, { method: "POST", body: JSON.stringify({ token, action, ...extra }) });
      body = await res.json();
    } catch (err) {
      // 통신이 끊겼거나 응답이 오다 끊긴 경우. 전송 대기열이 나중에 다시 보낸다
      throw Object.assign(new Error("서버에 연결하지 못했습니다. 통신 상태를 확인하세요"), { network: true, retryable: true });
    }
    if (!body.ok) {
      throw Object.assign(new Error(body.message || body.error), { code: body.error, retryable: !!body.retryable });
    }
    return body;
  },
  structure(placeId, text) { return this.call("structure", { place_id: placeId, text }); },
  saveVisit(visit) { return this.call("saveVisit", { visit }); },
  // 개발용: ?fixture=경로 가 있으면 API 대신 로컬 JSON을 읽는다
  async loadData() {
    const fixture = new URLSearchParams(location.search).get("fixture");
    if (fixture) {
      const body = await (await fetch(fixture)).json();
      return { fetchedAt: body.fetchedAt, data: body.data, fixture: true };
    }
    const body = await this.call("data");
    return { fetchedAt: body.fetchedAt, data: body.data };
  },
  savePlan(plan) { return this.call("savePlan", { plan }); },
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function todayKST() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
}

function loadKakao(appKey) {
  return new Promise((resolve, reject) => {
    if (window.kakao && window.kakao.maps && window.kakao.maps.Map) return resolve();
    if (!appKey) return reject(new Error("설정에서 카카오 JS 키를 입력하세요"));
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`;
    s.onload = () => window.kakao ? kakao.maps.load(resolve) : reject(new Error("카카오 지도를 불러오지 못했습니다"));
    s.onerror = () => reject(new Error("카카오 지도를 불러오지 못했습니다. JS 키와 도메인 등록을 확인하세요"));
    document.head.appendChild(s);
  });
}
