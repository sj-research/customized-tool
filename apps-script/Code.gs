/**
 * 상권 조사 도구 API
 *
 * 설치 위치: 구글 시트 cet_dongdaemun 의 확장 프로그램 > Apps Script
 * 이 코드에는 키, 토큰, 시트 주소, 구역 좌표가 없다. 토큰은 스크립트 속성 ACCESS_TOKEN 에 보관한다.
 *
 * 요청 방식
 *   POST, 본문은 JSON 문자열 { "token": "...", "action": "...", ... }
 *   웹앱에서 fetch(url, { method: "POST", body: JSON.stringify(...) }) 로 호출한다
 *   Content-Type 헤더를 따로 붙이지 않는다. 붙이면 브라우저 사전 요청 때문에 막힐 수 있다
 *
 * action
 *   ping           연결 확인
 *   data           전체 탭 읽기
 *   setBoundaries  zones 경계 칸에 구역 폴리곤 기록. { boundaries: { Z1: GeoJSON MultiPolygon, ... } }
 *   savePlan       routing_plans 저장. { plan: { plan_id?, date, zones[], order[], actualOrder[], memo } }
 */

const API_VERSION = "0.3";
const READ_SHEETS = ["zones", "places", "observations", "actions"];
// 없어도 오류 없이 빈 배열로 돌려주는 탭. setupSchema 실행과 blog 가져오기 전에도 API가 동작하게 한다
const OPTIONAL_SHEETS = ["visits", "routing_plans", "blog"];
const TIMEZONE = "Asia/Seoul";

/** 브라우저로 주소를 열었을 때 확인용. 데이터는 돌려주지 않는다 */
function doGet() {
  return json_({ ok: true, version: API_VERSION, message: "데이터는 POST 요청으로만 받을 수 있습니다" });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "bad_request" });
  }
  if (!checkToken_(req.token)) {
    return json_({ ok: false, error: "unauthorized" });
  }

  try {
    switch (req.action) {
      case "ping":
        return json_({
          ok: true,
          version: API_VERSION,
          sheets: SpreadsheetApp.getActive().getSheets().map(s => s.getName()),
          serverTime: formatDate_(new Date(), true),
        });
      case "data":
        return json_({
          ok: true,
          version: API_VERSION,
          fetchedAt: formatDate_(new Date(), true),
          data: READ_SHEETS.concat(OPTIONAL_SHEETS).reduce((acc, name) => {
            const exists = !!SpreadsheetApp.getActive().getSheetByName(name);
            acc[name] = exists || READ_SHEETS.includes(name) ? readSheet_(name) : [];
            return acc;
          }, {}),
        });
      case "setBoundaries":
        return json_(withLock_(() => setBoundaries_(req.boundaries)));
      case "savePlan":
        return json_(withLock_(() => savePlan_(req.plan)));
      default:
        return json_({ ok: false, error: "unknown_action" });
    }
  } catch (err) {
    if (err instanceof InputError) return json_({ ok: false, error: "invalid_input", message: err.message });
    return json_({ ok: false, error: "server_error", message: String(err) });
  }
}

/** 요청 값이 잘못됐을 때 쓰는 오류. 서버 오류와 구분해 알려준다 */
class InputError extends Error {}

/** 쓰기 요청이 동시에 들어와도 한 번에 하나씩 처리한다 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------
 * 쓰기
 * ------------------------------------------------------------------ */

function setBoundaries_(boundaries) {
  if (!boundaries || typeof boundaries !== "object" || Array.isArray(boundaries)) {
    throw new InputError("boundaries는 { 구역ID: 폴리곤 } 형식이어야 합니다");
  }
  const sheet = SpreadsheetApp.getActive().getSheetByName("zones");
  const boundaryCol = headerIndex_(sheet, "경계");
  if (!boundaryCol) throw new Error("zones 탭에 경계 컬럼이 없습니다");
  const ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().map(r => String(r[0]).trim());

  const updated = [], unknown = [];
  Object.keys(boundaries).forEach(zoneId => {
    const geom = boundaries[zoneId];
    const valid = geom && geom.type === "MultiPolygon" && Array.isArray(geom.coordinates) && geom.coordinates.length > 0;
    if (!valid) throw new InputError(`${zoneId}의 경계가 MultiPolygon 형식이 아닙니다`);
    const idx = ids.indexOf(zoneId);
    if (idx < 0) {
      unknown.push(zoneId);
      return;
    }
    sheet.getRange(idx + 2, boundaryCol).setValue(JSON.stringify(geom));
    updated.push(zoneId);
  });
  return { ok: true, updated, unknown };
}

function savePlan_(plan) {
  if (!plan || typeof plan !== "object") throw new InputError("plan이 없습니다");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date || "")) throw new InputError("date는 yyyy-MM-dd 형식이어야 합니다");
  const order = asIdList_(plan.order, "order");
  const actual = asIdList_(plan.actualOrder || [], "actualOrder");

  const nameOf = placeNames_();
  const unknownIds = order.concat(actual).filter(id => !nameOf[id]);
  if (unknownIds.length) throw new InputError(`places에 없는 place_id: ${unknownIds.join(", ")}`);

  const sheet = SpreadsheetApp.getActive().getSheetByName("routing_plans");
  if (!sheet) throw new Error("routing_plans 탭이 없습니다. setupSchema를 실행하세요");
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());

  let row;
  let planId = plan.plan_id;
  if (planId) {
    row = findRow_(sheet, planId);
    if (!row) throw new InputError(`routing_plans에 없는 plan_id: ${planId}`);
  } else {
    planId = "R" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMddHHmmss");
    row = firstEmptyRow_(sheet);
  }

  const values = {
    "plan_id": planId,
    "날짜": plan.date,
    "대상 구역": (plan.zones || []).join(", "),
    "방문 순서": order.join(", "),
    "방문 순서 상호명": order.map(id => nameOf[id]).join(", "),
    "실제 방문 순서": actual.join(", "),
    "실제 방문 순서 상호명": actual.map(id => nameOf[id]).join(", "),
    "메모": plan.memo || "",
    "수정일시": formatDate_(new Date(), true),
  };
  sheet.getRange(row, 1, 1, headers.length).setValues([headers.map(h => (h in values ? values[h] : ""))]);
  return { ok: true, plan: values };
}

function asIdList_(value, label) {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim())) {
    throw new InputError(`${label}는 place_id 문자열 배열이어야 합니다`);
  }
  return value.map(v => v.trim());
}

function placeNames_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName("places");
  const idCol = headerIndex_(sheet, "place_id"), nameCol = headerIndex_(sheet, "상호명");
  const values = sheet.getDataRange().getValues().slice(1);
  const map = {};
  values.forEach(r => { if (r[idCol - 1]) map[String(r[idCol - 1])] = String(r[nameCol - 1]); });
  return map;
}

function findRow_(sheet, id) {
  const ids = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).getValues();
  const idx = ids.findIndex(r => String(r[0]) === id);
  return idx < 0 ? 0 : idx + 2;
}

/** A열이 비어 있는 첫 행. 상호명 수식이 채워진 행도 A열이 비어 있으면 빈 행으로 본다 */
function firstEmptyRow_(sheet) {
  const ids = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).getValues();
  const idx = ids.findIndex(r => r[0] === "" || r[0] === null);
  if (idx >= 0) return idx + 2;
  const next = sheet.getMaxRows() + 1;
  sheet.insertRowsAfter(sheet.getMaxRows(), 100);
  return next;
}

/** 시트 한 탭을 [{컬럼명: 값}] 배열로 읽는다. 첫 칸이 빈 행(수식만 있는 빈 행 포함)은 건너뛴다 */
function readSheet_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error(`시트 탭을 찾을 수 없습니다: ${name}`);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());
  return values.slice(1)
    .filter(row => row[0] !== "" && row[0] !== null)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        if (!h) return;
        const v = row[i];
        obj[h] = v === "" ? null : v instanceof Date ? formatDate_(v) : v;
      });
      return obj;
    });
}

function formatDate_(d, withTime) {
  const hasTime = withTime || d.getHours() !== 0 || d.getMinutes() !== 0;
  return Utilities.formatDate(d, TIMEZONE, hasTime ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd");
}

function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty("ACCESS_TOKEN");
  if (!expected || typeof token !== "string" || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 편집기에서 한 번 직접 실행한다. 토큰이 없으면 만들고, 있으면 기존 토큰을 보여준다.
 * 실행 로그에 토큰이 표시된다.
 */
function setupToken() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty("ACCESS_TOKEN");
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    props.setProperty("ACCESS_TOKEN", token);
    Logger.log("새 토큰을 만들었습니다");
  }
  Logger.log("ACCESS_TOKEN: " + token);
}

/** 토큰이 노출됐을 때 실행한다. 새 토큰으로 바뀌고 기존 토큰은 더 이상 쓸 수 없다 */
function resetToken() {
  PropertiesService.getScriptProperties().deleteProperty("ACCESS_TOKEN");
  setupToken();
}

/** 편집기에서 읽기가 되는지 바로 확인할 때 실행한다 */
function testRead() {
  READ_SHEETS.concat(OPTIONAL_SHEETS).forEach(name => {
    const exists = !!SpreadsheetApp.getActive().getSheetByName(name);
    Logger.log(exists ? `${name}: ${readSheet_(name).length}행` : `${name}: 탭 없음`);
  });
}

/* ------------------------------------------------------------------
 * 시트 구조 추가. 편집기에서 한 번 실행한다. 여러 번 실행해도 안전하다
 * 기존 탭의 데이터는 바꾸지 않는다. 없는 탭, 없는 컬럼, 드롭다운 선택지만 추가한다
 * ------------------------------------------------------------------ */

const MAX_ROWS = 2000;
const HEADER_BG = "#1f3a5f";

// 상호명 칸: B열 place_id로 places 상호명을 찾는다. zone_id면 구역명. 한 칸짜리 배열 수식이라 새 행에도 자동 적용된다
const NAME_ARRAY_FORMULA =
  '={"상호명";ARRAYFORMULA(IF(B2:B="","",IFERROR(VLOOKUP(B2:B,{places!A:A,places!C:C},2,FALSE),' +
  'IFERROR(VLOOKUP(B2:B,{zones!A:A,zones!C:C},2,FALSE),"확인필요"))))}';

const NEW_SHEETS = {
  visits: {
    headers: ["visit_id", "place_id", "상호명", "방문일시", "plan_id", "방문 결과", "재방문 희망 시각",
              "검수 상태", "녹음 원문", "구조화 결과", "비고"],
    formulaCol: 3,
    lists: { "방문 결과": ["완료", "키맨부재", "브레이크타임", "영업전", "재방문필요"], "검수 상태": ["미검수", "검수완료"] },
  },
  routing_plans: {
    headers: ["plan_id", "날짜", "대상 구역", "방문 순서", "방문 순서 상호명", "실제 방문 순서", "실제 방문 순서 상호명",
              "메모", "수정일시"],
    lists: {},
  },
};

const PLACE_STATUS = ["미방문", "관측완료", "상담완료", "재방문필요", "제외"];

function setupSchema() {
  const ss = SpreadsheetApp.getActive();
  const done = [];

  Object.keys(NEW_SHEETS).forEach(name => {
    const spec = NEW_SHEETS[name];
    let sheet = ss.getSheetByName(name);
    if (sheet) {
      done.push(`${name}: 이미 있음. 건드리지 않음`);
      return;
    }
    sheet = ss.insertSheet(name);
    if (sheet.getMaxRows() < MAX_ROWS) sheet.insertRowsAfter(sheet.getMaxRows(), MAX_ROWS - sheet.getMaxRows());
    const header = sheet.getRange(1, 1, 1, spec.headers.length);
    header.setValues([spec.headers]).setFontWeight("bold").setFontColor("#ffffff").setBackground(HEADER_BG);
    sheet.setFrozenRows(1);
    if (spec.formulaCol) sheet.getRange(1, spec.formulaCol).setFormula(NAME_ARRAY_FORMULA);
    Object.keys(spec.lists).forEach(col => {
      const idx = spec.headers.indexOf(col) + 1;
      setListValidation_(sheet, idx, spec.lists[col]);
    });
    done.push(`${name}: 탭 생성`);
  });

  const places = ss.getSheetByName("places");
  const statusCol = headerIndex_(places, "진행상태");
  if (!statusCol) throw new Error("places 탭에 진행상태 컬럼이 없습니다");
  setListValidation_(places, statusCol, PLACE_STATUS);
  done.push(`places 진행상태 선택지: ${PLACE_STATUS.join(", ")}`);

  const obs = ss.getSheetByName("observations");
  if (headerIndex_(obs, "visit_id")) {
    done.push("observations visit_id: 이미 있음");
  } else {
    const col = obs.getLastColumn() + 1;
    if (obs.getMaxColumns() < col) obs.insertColumnAfter(obs.getMaxColumns());
    const ref = obs.getRange(1, 1);
    obs.getRange(1, col).setValue("visit_id")
      .setFontWeight("bold").setFontColor(ref.getFontColor()).setBackground(ref.getBackground());
    done.push(`observations visit_id: ${col}번째 컬럼에 추가`);
  }

  done.forEach(line => Logger.log(line));
}

function headerIndex_(sheet, name) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  return headers.indexOf(name) + 1;
}

function setListValidation_(sheet, col, values) {
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
}
