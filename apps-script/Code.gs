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
 *   structure      녹음 원문을 Claude로 구조화. 저장하지 않는다. { place_id, text }
 *   saveVisit      방문 저장. visits 1행, observations 여러 행, places 진행상태 갱신. { visit: {...} }
 *   mapData        현장 지도용 읽기. zones, places만. { }
 *   setStatus      places 진행상태 변경. { place_id, status, reason?, time?, manage? }
 *   addPlace       places에 새 행. 임의 핀 { name, lat, lng }, 검색 결과 { name, lat, lng, kakao: { id, category, address, url } }, 비고 지정 note?
 *   saveSurvey     "전수 조사" 탭에 표를 쓴다. 이미 내용이 있으면 overwrite: true일 때만 덮어쓴다. { headers[], rows[][], overwrite? }
 *   addDictionary  사전 탭에 행 추가. 같은 인식결과가 있으면 건너뛴다. { items: [{ 구분, 용어 또는 인식결과, 의미 또는 교정, 상태, 비고 }] }
 *   setBees        BEES 필수 방문 업장 일괄 반영. 있으면 BEES 체크만, 없으면 새 행. { items: [{ name, lat, lng, address?, url?, kakao? }] }
 *
 * 스크립트 속성
 *   ACCESS_TOKEN       접근 토큰 (setupToken으로 생성)
 *   ANTHROPIC_API_KEY  Claude API 키. 프로젝트 설정 > 스크립트 속성에 직접 넣는다
 *   CLAUDE_MODEL       선택. 기본 claude-opus-5
 *   CLAUDE_EFFORT      선택. 기본 medium (low, medium, high)
 */

const API_VERSION = "0.10";
const READ_SHEETS = ["zones", "places", "observations", "actions"];
// 없어도 오류 없이 빈 배열로 돌려주는 탭. setupSchema 실행과 blog 가져오기 전에도 API가 동작하게 한다
const OPTIONAL_SHEETS = ["visits", "routing_plans", "blog", "사전"];
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
      case "structure":
        return json_(structure_(req.place_id, req.text));
      case "saveVisit":
        return json_(saveVisit_(req.visit));
      case "mapData":
        return json_({ ok: true, version: API_VERSION, fetchedAt: formatDate_(new Date(), true),
                       data: { zones: readSheet_("zones"), places: readSheet_("places") } });
      case "setStatus":
        return json_(withLock_(() => setStatus_(req)));
      case "addPlace":
        return json_(withLock_(() => addPlace_(req)));
      case "setBees":
        return json_(withLock_(() => setBees_(req)));
      case "saveSurvey":
        return json_(withLock_(() => saveSurvey_(req)));
      case "addDictionary":
        return json_(withLock_(() => addDictionary_(req)));
      default:
        return json_({ ok: false, error: "unknown_action" });
    }
  } catch (err) {
    if (err instanceof InputError) return json_({ ok: false, error: "invalid_input", message: err.message });
    if (err instanceof ClaudeError) return json_({ ok: false, error: err.code, message: err.message, retryable: err.retryable });
    return json_({ ok: false, error: "server_error", message: String(err) });
  }
}

/** 요청 값이 잘못됐을 때 쓰는 오류. 서버 오류와 구분해 알려준다 */
class InputError extends Error {}

/** Claude 호출 오류. retryable이면 앱이 전송 대기열에 두고 나중에 다시 보낸다 */
class ClaudeError extends Error {
  constructor(code, message, retryable) {
    super(message);
    this.code = code;
    this.retryable = !!retryable;
  }
}

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

  ensurePlaceColumns_().forEach(c => done.push(`places ${c.name}: ${c.added ? `${c.col}번째 컬럼에 추가` : "이미 있음"}`));

  const obs = ss.getSheetByName("observations");
  const visitCol = addHeaderColumn_(obs, "visit_id");
  done.push(`observations visit_id: ${visitCol.added ? `${visitCol.col}번째 컬럼에 추가` : "이미 있음"}`);

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

/* ------------------------------------------------------------------
 * 현장 모드: 녹음 구조화와 방문 저장
 * ------------------------------------------------------------------ */

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT = "medium";
const VISIT_RESULTS = ["완료", "키맨부재", "브레이크타임", "영업전", "재방문필요"];
const MAX_TEXT = 5000;

const nullable_ = schema => ({ anyOf: [schema, { type: "null" }] });
const enum_ = values => ({ type: "string", enum: values });
const strArray_ = { type: "array", items: { type: "string" } };
const YNU_ = enum_(["Y", "N", "미확인"]);

// 관찰 한 행. [스키마 키, observations 탭 컬럼명, 스키마]. 스키마 키는 영문으로 두고 저장할 때 컬럼명으로 옮긴다
const OBS_FIELDS = [
  ["method", "조사방식", enum_(["외부관측", "내부진입", "업주인터뷰", "제3자전언"])],
  ["evidence", "근거유형", enum_(["E1 관측", "E2 추론", "E3 전언"])],
  ["informant", "전언주체", nullable_(enum_(["업주", "직원", "아르바이트", "인근상인", "상가종사자", "부동산", "기타"]))],
  ["draft_beer", "생맥주", YNU_],
  ["bottle_beer", "병맥주", YNU_],
  ["own_brands", "자사브랜드", strArray_],
  ["competitor_brands", "경쟁브랜드", strArray_],
  ["soju_brands", "소주브랜드", strArray_],
  ["other_drinks", "기타주류", strArray_],
  ["nab_potential", "NAB적용가능성", nullable_(enum_(["높음", "보통", "낮음", "해당없음"]))],
  ["pocm", "POCM유무", YNU_],
  ["pocm_types", "POCM유형", { type: "array", items: enum_(["LED", "포스터", "간판", "앞치마", "가판", "이벤트물"]) }],
  ["pocm_brands", "POCM브랜드", strArray_],
  ["pocm_location", "POCM위치", nullable_(enum_(["내부", "외부", "둘 다"]))],
  ["pocm_density", "POCM밀도", nullable_(enum_(["없음", "소수", "다수"]))],
  ["stock_evidence", "물증수량", nullable_({ type: "string" })],
  ["patio", "야장", nullable_(enum_(["Y", "N"]))],
  ["crowd", "혼잡도", nullable_(enum_(["한산", "보통", "성황"]))],
  ["waiting", "대기발생", nullable_({ type: "string" })],
  ["age_groups", "고객연령대", { type: "array", items: enum_(["20대", "30대", "40대", "50대", "60대이상"]) }],
  ["foreign_share", "외국인비중", nullable_(enum_(["없음", "일부", "다수"]))],
  ["nationalities", "추정국적", strArray_],
  ["note", "특이사항", { type: "string" }],
  ["excerpt", "원문발췌", { type: "string" }],
];

const STRUCTURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "visit_result_hint", "revisit_time"],
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: OBS_FIELDS.map(f => f[0]),
        properties: Object.fromEntries(OBS_FIELDS.map(([key, , schema]) => [key, schema])),
      },
    },
    visit_result_hint: nullable_(enum_(VISIT_RESULTS)),
    revisit_time: nullable_({ type: "string" }),
  },
};

const STRUCTURE_RULES = `당신은 주류 영업 상권 조사원의 현장 음성 메모를 조사 기록으로 정리한다.
입력은 아이폰 음성 인식으로 받아쓴 한국어 원문이라 오인식이 섞여 있다. 어느 업장 앞에서 녹음했는지는 따로 주어진다.

관찰 나누기
- 근거 유형이 다른 내용은 관찰을 나눈다. 한 관찰에는 한 가지 근거 유형만 담는다.
- E1 관측: 직접 본 것. 예: 테라 POCM이 붙어 있음, 카스 생맥주 통 8개.
- E2 추론: 관측을 근거로 한 추측. "~같다", "~로 보인다", "~추정", "~예상" 같은 표현. 사실로 쓰지 않는다.
- E3 전언: 들은 것. 전언주체를 반드시 채운다. 주체를 알 수 없으면 기타.
- 조사방식: 밖에서 봤으면 외부관측, 들어가서 봤으면 내부진입, 사장님이나 직원과 대화했으면 업주인터뷰, 옆 가게 등 제3자에게 들었으면 제3자전언.

값 채우기
- 말하지 않은 것은 채우지 않는다. Y/N/미확인 칸은 미확인, 나머지는 null 또는 빈 배열이다. 추측으로 채우지 않는다.
- 브랜드는 아래 사전의 표기로 맞춘다. 자사 브랜드 목록에 있으면 자사브랜드, 그 밖의 맥주는 경쟁브랜드, 소주는 소주브랜드, 하이볼과 와인 등은 기타주류에 넣는다.
- POCM은 업장 안팎의 주류 홍보물이다. 음성 인식이 "PC엠", "PC M", "피씨엠", "피오씨엠" 등으로 적었으면 POCM으로 읽는다.
- 사전의 STT 교정 중 상태가 자동교정인 것은 교정해서 읽는다. 확인대기인 것은 원문 그대로 둔다.
- 특이사항은 그 관찰의 핵심을 짧게 쓴다. 가운뎃점, 대시, 하이픈을 문장부호로 쓰지 않는다.
- 원문발췌는 그 관찰의 근거가 된 원문 구간을 고치지 않고 그대로 옮긴다.
- 업장 이름은 주어지므로 원문에서 상호명을 따로 뽑지 않는다.
- 조사와 무관한 말만 있으면 observations는 빈 배열이다.

출력 키와 뜻
method 조사방식, evidence 근거유형, informant 전언주체, draft_beer 생맥주 취급, bottle_beer 병맥주 취급,
own_brands 자사 브랜드, competitor_brands 경쟁 맥주 브랜드, soju_brands 소주 브랜드, other_drinks 기타 주류,
nab_potential 무알코올 맥주(NAB) 적용 가능성, pocm POCM 유무, pocm_types POCM 유형, pocm_brands POCM에 적힌 브랜드,
pocm_location POCM 위치, pocm_density 경쟁사 POCM이 얼마나 많은지, stock_evidence 케이스나 생맥주 통 적재량 같은 물증,
patio 야장(외부 좌석 영업) 여부, crowd 혼잡도, waiting 대기 팀 수, age_groups 고객 연령대, foreign_share 외국인 비중,
nationalities 추정 국적, note 특이사항, excerpt 원문발췌.

방문 결과와 재방문
- visit_result_hint: 원문에 방문 결과가 드러나면 채운다. 사장님이나 발주 담당자가 없음은 키맨부재, 브레이크 타임은 브레이크타임, 아직 문을 안 열었음은 영업전. 드러나지 않으면 null.
- revisit_time: 다시 오라는 시각이나 사장님 출근 시각이 나오면 "18:00"처럼 24시간 형식으로 쓴다. 시각이 애매하면 원문 표현을 그대로 쓴다. 없으면 null.`;

function claudeSettings_() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("ANTHROPIC_API_KEY");
  if (!key) throw new ClaudeError("no_api_key", "스크립트 속성에 ANTHROPIC_API_KEY가 없습니다", false);
  return {
    key,
    model: props.getProperty("CLAUDE_MODEL") || DEFAULT_MODEL,
    effort: props.getProperty("CLAUDE_EFFORT") || DEFAULT_EFFORT,
  };
}

function dictionaryText_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName("사전");
  if (!sheet) return "(사전 탭 없음)";
  return readSheet_("사전").map(r =>
    [r["구분"], r["용어 또는 인식결과"], r["의미 또는 교정"], r["상태"]].filter(v => v !== null && v !== "").join(" | ")
  ).join("\n");
}

function placeInfo_(placeId) {
  const place = readSheet_("places").find(p => String(p.place_id) === String(placeId));
  if (!place) throw new InputError(`places에 없는 place_id: ${placeId}`);
  return place;
}

/** 저장하지 않고 구조화 결과만 돌려준다. 칩으로 확인하고 고친 뒤 saveVisit으로 저장한다 */
function structure_(placeId, text) {
  const place = placeInfo_(placeId);
  return { ok: true, ...callClaude_(place, text) };
}

function callClaude_(place, text) {
  if (typeof text !== "string" || !text.trim()) throw new InputError("녹음 원문이 비어 있습니다");
  if (text.length > MAX_TEXT) throw new InputError(`녹음 원문이 ${MAX_TEXT}자를 넘습니다`);
  const s = claudeSettings_();

  const kind = place["업태서술"] || place["카카오 업종"] || "미확인";
  const payload = {
    model: s.model,
    max_tokens: 16000,
    system: `${STRUCTURE_RULES}\n\n사전 (구분 | 용어 또는 인식결과 | 의미 또는 교정 | 상태)\n${dictionaryText_()}`,
    messages: [{
      role: "user",
      content: `업장: ${place["상호명"]} (${place.zone_id || "구역 미상"}, 업태 ${kind})\n\n녹음 원문:\n${text.trim()}`,
    }],
    output_config: { effort: s.effort, format: { type: "json_schema", schema: STRUCTURE_SCHEMA } },
  };
  const headers = { "x-api-key": s.key, "anthropic-version": "2023-06-01" };
  // Opus 5와 Fable 계열은 안전 판정 거절 시 서버가 다른 모델로 다시 실행하도록 한다
  if (/^claude-(opus-5|fable)/.test(s.model)) {
    payload.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }

  const started = Date.now();
  const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post", contentType: "application/json", headers, payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (e) {
    throw new ClaudeError("claude_error", `Claude 응답을 읽을 수 없습니다 (HTTP ${code})`, code >= 500);
  }
  if (code !== 200) {
    const msg = (body.error && body.error.message) || `HTTP ${code}`;
    const retryable = code === 429 || code >= 500;
    throw new ClaudeError(retryable ? "claude_busy" : "claude_error", `Claude 호출 실패: ${msg}`, retryable);
  }
  if (body.stop_reason === "refusal") throw new ClaudeError("claude_refusal", "Claude가 이 요청을 처리하지 않았습니다", false);
  if (body.stop_reason === "max_tokens") throw new ClaudeError("claude_error", "구조화 결과가 길이 제한에 걸렸습니다", false);

  const textBlock = (body.content || []).find(b => b.type === "text");
  if (!textBlock) throw new ClaudeError("claude_error", "구조화 결과가 비어 있습니다", false);
  let structured;
  try {
    structured = JSON.parse(textBlock.text);
  } catch (e) {
    throw new ClaudeError("claude_error", "구조화 결과가 JSON 형식이 아닙니다", false);
  }
  return { structured, model: body.model, usage: body.usage, elapsedMs: Date.now() - started };
}

/**
 * visit = { client_id, place_id, visited_at "yyyy-MM-dd HH:mm", plan_id?, result, revisit_time?, text, structured? }
 * structured가 없고 text가 있으면 여기서 구조화한다 (통신이 끊겨 구조화를 못 한 채 대기열에 들어간 방문)
 * 같은 client_id로 다시 오면 새로 쓰지 않고 먼저 저장한 결과를 돌려준다
 */
function saveVisit_(visit) {
  if (!visit || typeof visit !== "object") throw new InputError("visit이 없습니다");
  if (typeof visit.client_id !== "string" || !visit.client_id) throw new InputError("client_id가 없습니다");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(visit.visited_at || "")) throw new InputError("visited_at은 yyyy-MM-dd HH:mm 형식이어야 합니다");
  if (!VISIT_RESULTS.includes(visit.result)) throw new InputError(`방문 결과는 ${VISIT_RESULTS.join(", ")} 중 하나여야 합니다`);
  const place = placeInfo_(visit.place_id);

  const existing = findVisitByClientId_(visit.client_id);
  if (existing) return { ok: true, duplicate: true, ...existing };

  let structured = visit.structured;
  let structuredBy = "앱에서 확인";
  if (!structured) {
    structured = visit.text && visit.text.trim() ? callClaude_(place, visit.text).structured : { observations: [] };
    structuredBy = "대기열 자동 구조화";
  }
  const observations = Array.isArray(structured.observations) ? structured.observations : [];

  return withLock_(() => {
    const again = findVisitByClientId_(visit.client_id);
    if (again) return { ok: true, duplicate: true, ...again };

    const ss = SpreadsheetApp.getActive();
    const visitsSheet = ss.getSheetByName("visits");
    const obsSheet = ss.getSheetByName("observations");
    if (!visitsSheet) throw new Error("visits 탭이 없습니다. setupSchema를 실행하세요");

    const visitId = "V" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMddHHmmss") + String(Date.now() % 1000).padStart(3, "0");
    const visitRow = {
      "visit_id": visitId, "place_id": place.place_id, "방문일시": visit.visited_at, "plan_id": visit.plan_id || "",
      "방문 결과": visit.result, "재방문 희망 시각": visit.revisit_time || "", "검수 상태": "미검수",
      "녹음 원문": visit.text || "", "구조화 결과": JSON.stringify(structured),
      "비고": `client:${visit.client_id} / ${structuredBy}`,
    };
    writeRow_(visitsSheet, firstEmptyRow_(visitsSheet), visitRow);

    let nextObs = maxIdNumber_(obsSheet, "O") + 1;
    const obsRows = observations.map(o => {
      const row = { "obs_id": "O" + String(nextObs++).padStart(3, "0"), "place_id": place.place_id, "조사일시": visit.visited_at,
                    "소스파일": "현장앱", "visit_id": visitId };
      OBS_FIELDS.forEach(([key, column]) => {
        const v = o[key];
        row[column] = Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : v;
      });
      writeRow_(obsSheet, firstEmptyRow_(obsSheet), row);
      return row;
    });

    const status = updatePlaceStatus_(place.place_id, visit.result, observations, visit.visited_at.slice(0, 10));
    return { ok: true, duplicate: false, visit: visitRow, observations: obsRows, place_status: status };
  });
}

function findVisitByClientId_(clientId) {
  const sheet = SpreadsheetApp.getActive().getSheetByName("visits");
  if (!sheet) return null;
  const mark = `client:${clientId}`;
  const row = readSheet_("visits").find(v => String(v["비고"] || "").split(" / ")[0] === mark);
  return row ? { visit: row, observations: [], place_status: null } : null;
}

/**
 * 헤더 이름으로 한 행을 쓴다. skipName 칸은 건너뛰고 그 앞뒤 구간을 한 번씩 쓴다
 * observations와 visits의 상호명 칸은 수식이라 기본으로 건너뛴다. places처럼 상호명이 값인 탭은 skipName을 null로 준다
 */
function writeRow_(sheet, rowIndex, values, skipName = "상호명") {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const skip = skipName ? headers.indexOf(skipName) : -1;
  const segments = skip < 0 ? [[0, headers.length]] : [[0, skip], [skip + 1, headers.length]];
  segments.forEach(([from, to]) => {
    if (to <= from) return;
    const row = headers.slice(from, to).map(h => (h in values ? values[h] : ""));
    sheet.getRange(rowIndex, from + 1, 1, to - from).setValues([row]);
  });
}

function maxIdNumber_(sheet, prefix) {
  const ids = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).getValues();
  return ids.reduce((max, r) => {
    const m = String(r[0]).match(new RegExp(`^${prefix}(\\d+)$`));
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
}

/** 완료면 관측완료(업주인터뷰가 있으면 상담완료, 이미 상담완료면 유지). 완료가 아니면 재방문필요 */
function updatePlaceStatus_(placeId, result, observations, date) {
  const sheet = SpreadsheetApp.getActive().getSheetByName("places");
  const row = findRow_(sheet, String(placeId));
  if (!row) return null;
  const statusCol = headerIndex_(sheet, "진행상태");
  const firstCol = headerIndex_(sheet, "최초조사일");
  const current = String(sheet.getRange(row, statusCol).getValue());
  let next;
  if (result === "완료") {
    const interviewed = observations.some(o => o.method === "업주인터뷰");
    next = interviewed || current === "상담완료" ? "상담완료" : "관측완료";
  } else {
    next = "재방문필요";
  }
  if (current !== "제외") sheet.getRange(row, statusCol).setValue(next);
  if (firstCol && !sheet.getRange(row, firstCol).getValue()) sheet.getRange(row, firstCol).setValue(date);
  return current === "제외" ? "제외" : next;
}

/* ------------------------------------------------------------------
 * 현장 지도 MVP: 진행상태 변경과 임의 핀
 * ------------------------------------------------------------------ */

// 앱이 쓰는 진행상태 값. 상담완료는 앱이 쓰지 않고, 이미 상담완료면 완료로 바꿔도 덮어쓰지 않는다
const MAP_STATUS = ["미방문", "관측완료", "재방문필요", "제외"];
const REVISIT_REASONS = ["키맨 부재", "브레이크 타임", "영업 전", "기타"];
const PLACE_EXTRA_COLUMNS = ["재방문사유", "재방문예정시각", "관리"];

/** 헤더에 컬럼이 없으면 맨 뒤에 추가한다. { col, added } */
function addHeaderColumn_(sheet, name) {
  const existing = headerIndex_(sheet, name);
  if (existing) return { col: existing, added: false };
  const col = sheet.getLastColumn() + 1;
  if (sheet.getMaxColumns() < col) sheet.insertColumnAfter(sheet.getMaxColumns());
  const ref = sheet.getRange(1, 1);
  sheet.getRange(1, col).setValue(name)
    .setFontWeight("bold").setFontColor(ref.getFontColor()).setBackground(ref.getBackground());
  // 끼워 넣은 열은 왼쪽 열의 데이터 확인 규칙(드롭다운 등)을 물려받는다. 새 열은 규칙 없이 시작한다
  sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).clearDataValidations();
  return { col, added: true };
}

/** places에 재방문사유, 재방문예정시각, 관리 컬럼이 없으면 추가한다. 재방문사유에는 드롭다운, 관리에는 체크박스를 건다 */
function ensurePlaceColumns_() {
  const places = SpreadsheetApp.getActive().getSheetByName("places");
  return PLACE_EXTRA_COLUMNS.map(name => {
    const r = addHeaderColumn_(places, name);
    if (r.added && name === "재방문사유") setListValidation_(places, r.col, REVISIT_REASONS);
    if (r.added && name === "관리") setCheckboxValidation_(places, r.col);
    // 0.8까지는 재방문예정시각 열이 재방문사유 드롭다운을 물려받아 시간을 쓰면 오류가 났다. 남아 있으면 지운다
    if (name === "재방문예정시각" && places.getRange(2, r.col).getDataValidation()) {
      places.getRange(2, r.col, places.getMaxRows() - 1, 1).clearDataValidations();
    }
    return { name, ...r };
  });
}

function setCheckboxValidation_(sheet, col) {
  const rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
}

function setStatus_(req) {
  const placeId = String(req.place_id || "");
  if (!MAP_STATUS.includes(req.status)) throw new InputError(`진행상태는 ${MAP_STATUS.join(", ")} 중 하나여야 합니다`);
  const revisit = req.status === "재방문필요";
  if (revisit && !REVISIT_REASONS.includes(req.reason)) throw new InputError(`재방문 사유는 ${REVISIT_REASONS.join(", ")} 중 하나여야 합니다`);
  const time = revisit && req.time ? String(req.time).trim().slice(0, 50) : "";

  ensurePlaceColumns_();
  const sheet = SpreadsheetApp.getActive().getSheetByName("places");
  const row = placeId ? findRow_(sheet, placeId) : 0;
  if (!row) throw new InputError(`places에 없는 place_id: ${placeId}`);
  const statusCol = headerIndex_(sheet, "진행상태");
  const reasonCol = headerIndex_(sheet, "재방문사유");
  const timeCol = headerIndex_(sheet, "재방문예정시각");
  const manageCol = headerIndex_(sheet, "관리");

  const current = String(sheet.getRange(row, statusCol).getValue());
  const keepConsult = req.status === "관측완료" && current === "상담완료";
  const next = keepConsult ? "상담완료" : req.status;
  if (!keepConsult) sheet.getRange(row, statusCol).setValue(next);
  // 재방문이 아니면 사유와 예정시각을 비운다. 이전 재방문 사유가 남아 헷갈리지 않게 한다
  sheet.getRange(row, reasonCol).setValue(revisit ? req.reason : "");
  // 일반 서식이면 14:00은 시각, 12는 숫자로 바뀐다. 입력한 글자 그대로 남기려고 텍스트 서식으로 쓴다
  sheet.getRange(row, timeCol).setNumberFormat("@").setValue(time);
  // 관리 체크는 완료일 때만 둔다. 완료가 아니게 되면 해제한다. 완료인데 값이 안 오면 기존 값을 유지한다
  const manageCell = sheet.getRange(row, manageCol);
  if (req.status !== "관측완료") manageCell.setValue(false);
  else if (typeof req.manage === "boolean") manageCell.setValue(req.manage);
  const manage = manageCell.getValue() === true;
  return { ok: true, place_id: placeId, "진행상태": next, "재방문사유": revisit ? req.reason : "", "재방문예정시각": time, "관리": manage };
}

function addPlace_(req) {
  const name = String(req.name || "").trim();
  if (!name) throw new InputError("상호명을 입력하세요");
  if (name.length > 100) throw new InputError("상호명이 너무 깁니다");
  const lat = Number(req.lat), lng = Number(req.lng);
  // 대한민국 범위 밖 좌표는 잘못 찍힌 값으로 본다
  if (!(lat > 33 && lat < 39 && lng > 124 && lng < 132)) throw new InputError("좌표가 올바르지 않습니다");

  // 검색에서 고른 카카오 업장이면 kakao = { id, category, address, url }. 없으면 지도에서 찍은 임의 핀
  const kakao = req.kakao && typeof req.kakao === "object" ? req.kakao : null;
  if (kakao && !/^\d+$/.test(String(kakao.id || ""))) throw new InputError("카카오 업장 id가 올바르지 않습니다");

  const sheet = SpreadsheetApp.getActive().getSheetByName("places");
  if (kakao) {
    // 같은 카카오 업장이 이미 명단에 있으면 새로 넣지 않고 기존 행을 돌려준다
    const existing = readSheet_("places").find(p => String(p.kakao_id || "") === String(kakao.id));
    if (existing) return { ok: true, duplicate: true, place: existing };
  }
  const placeId = "P" + String(maxIdNumber_(sheet, "P") + 1).padStart(3, "0");
  const values = {
    "place_id": placeId, "zone_id": zoneOfPoint_(lng, lat), "상호명": name, "상호명_상태": kakao ? "확정" : "확인대기",
    "대상유형": "POC", "출처": "현장추가", "POC seg_상태": "확인대기", "lat": lat, "lng": lng, "좌표출처": kakao ? "카카오" : "수동",
    "진행상태": "미방문", "최초조사일": Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd"),
    "비고": req.note ? String(req.note).slice(0, 100) : kakao ? "현장 지도 검색으로 추가" : "현장 지도 임의 핀",
  };
  if (kakao) {
    values["kakao_id"] = String(kakao.id);
    values["카카오 업종"] = String(kakao.category || "");
    values["주소"] = String(kakao.address || "");
    values["지도링크"] = String(kakao.url || "");
  }
  writeRow_(sheet, firstEmptyRow_(sheet), values, null);
  return { ok: true, duplicate: false, place: values };
}

/**
 * BEES 필수 방문 업장을 반영한다. 여러 번 실행해도 결과가 같다
 * 카카오 업장은 kakao_id로, 카카오에 없는 업장은 상호명과 주소로 기존 행을 찾는다
 * 기존 행은 BEES만 체크하고 다른 칸은 건드리지 않는다. 없으면 진행상태 미방문으로 새 행을 만든다
 */
const SURVEY_TAB = "전수 조사";

/** 현장 녹음을 정리한 표를 "전수 조사" 탭에 쓴다. 손으로 고친 내용을 실수로 지우지 않게, 이미 있으면 overwrite가 있어야 덮어쓴다 */
function saveSurvey_(req) {
  const headers = Array.isArray(req.headers) ? req.headers.map(h => String(h).trim()) : [];
  const rows = Array.isArray(req.rows) ? req.rows : [];
  if (!headers.length || headers.length > 40 || headers.some(h => !h)) throw new InputError("headers가 올바르지 않습니다");
  if (rows.length > 3000 || rows.some(r => !Array.isArray(r) || r.length !== headers.length)) throw new InputError("rows는 headers와 칸 수가 같은 배열이어야 합니다");
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SURVEY_TAB);
  if (sheet && sheet.getLastRow() > 1 && req.overwrite !== true) {
    throw new InputError(`${SURVEY_TAB} 탭에 이미 ${sheet.getLastRow() - 1}행이 있습니다. 덮어쓰려면 overwrite를 켜세요`);
  }
  if (!sheet) sheet = ss.insertSheet(SURVEY_TAB);
  sheet.clearContents();
  if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  if (sheet.getMaxRows() < rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  const values = [headers, ...rows.map(r => r.map(v => (v === null || v === undefined ? "" : String(v))))];
  // 날짜처럼 보이는 값이 바뀌지 않게 텍스트 서식으로 쓴다
  sheet.getRange(1, 1, values.length, headers.length).setNumberFormat("@").setValues(values);
  const ref = ss.getSheetByName("places").getRange(1, 1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setFontColor(ref.getFontColor()).setBackground(ref.getBackground());
  sheet.setFrozenRows(1);
  return { ok: true, tab: SURVEY_TAB, rows: rows.length };
}

const DICTIONARY_FIELDS = ["구분", "용어 또는 인식결과", "의미 또는 교정", "상태", "비고"];

function addDictionary_(req) {
  const items = Array.isArray(req.items) ? req.items : [];
  if (!items.length || items.length > 200) throw new InputError("items는 1건 이상 200건 이하여야 합니다");
  const sheet = SpreadsheetApp.getActive().getSheetByName("사전");
  if (!sheet) throw new InputError("사전 탭이 없습니다");
  const existing = new Set(readSheet_("사전").map(r => String(r["용어 또는 인식결과"] || "").trim()));
  const results = items.map(item => {
    const values = {};
    DICTIONARY_FIELDS.forEach(f => { values[f] = String(item[f] || "").trim().slice(0, 300); });
    const key = values["용어 또는 인식결과"];
    if (!values["구분"] || !key) throw new InputError("구분과 용어 또는 인식결과는 필수입니다");
    if (existing.has(key)) return { term: key, result: "이미 있음" };
    writeRow_(sheet, sheet.getLastRow() + 1, values, null);
    existing.add(key);
    return { term: key, result: "추가" };
  });
  return { ok: true, results };
}

function setBees_(req) {
  const items = Array.isArray(req.items) ? req.items : [];
  if (!items.length || items.length > 100) throw new InputError("items는 1건 이상 100건 이하여야 합니다");
  ensurePlaceColumns_();
  const sheet = SpreadsheetApp.getActive().getSheetByName("places");
  const bees = addHeaderColumn_(sheet, "BEES");
  if (bees.added) setCheckboxValidation_(sheet, bees.col);
  const beesCol = bees.col;
  const places = readSheet_("places");
  const today = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
  const same = (a, b) => String(a || "").replace(/\s+/g, "") === String(b || "").replace(/\s+/g, "");

  const results = items.map(item => {
    const name = String(item.name || "").trim();
    const lat = Number(item.lat), lng = Number(item.lng);
    if (!name || name.length > 100) throw new InputError(`상호명이 올바르지 않습니다: ${name}`);
    if (!(lat > 33 && lat < 39 && lng > 124 && lng < 132)) throw new InputError(`좌표가 올바르지 않습니다: ${name}`);
    const kakao = item.kakao && typeof item.kakao === "object" ? item.kakao : null;
    if (kakao && !/^\d+$/.test(String(kakao.id || ""))) throw new InputError(`카카오 업장 id가 올바르지 않습니다: ${name}`);
    const address = String((kakao && kakao.address) || item.address || "");

    const existing = kakao
      ? places.find(p => String(p.kakao_id || "") === String(kakao.id))
      : places.find(p => same(p["상호명"], name) && same(p["주소"], address));
    if (existing) {
      sheet.getRange(findRow_(sheet, String(existing.place_id)), beesCol).setValue(true);
      return { name, place_id: String(existing.place_id), result: "기존 행에 BEES 체크" };
    }
    const placeId = "P" + String(maxIdNumber_(sheet, "P") + 1).padStart(3, "0");
    const values = {
      "place_id": placeId, "zone_id": zoneOfPoint_(lng, lat), "상호명": name, "상호명_상태": kakao ? "확정" : "확인대기",
      "대상유형": "POC", "출처": kakao ? "카카오" : "현장추가", "POC seg_상태": "확인대기", "lat": lat, "lng": lng,
      "좌표출처": kakao ? "카카오" : "수동", "주소": address, "지도링크": String((kakao && kakao.url) || item.url || ""),
      "진행상태": "미방문", "최초조사일": today, "BEES": true,
      "비고": kakao ? "BEES 목록" : "BEES 목록. 카카오 미등록, 전달받은 주소로 좌표 지정",
    };
    if (kakao) {
      values["kakao_id"] = String(kakao.id);
      values["카카오 업종"] = String(kakao.category || "");
    }
    writeRow_(sheet, firstEmptyRow_(sheet), values, null);
    places.push(values);
    return { name, place_id: placeId, result: "새 행 추가" };
  });
  return { ok: true, results };
}

/** zones 경계(MultiPolygon)에 들어가는 구역. 없으면 빈 문자열 */
function zoneOfPoint_(lng, lat) {
  for (const z of readSheet_("zones")) {
    let geom;
    try { geom = JSON.parse(z["경계"]); } catch (e) { continue; }
    if (!geom || geom.type !== "MultiPolygon") continue;
    if (geom.coordinates.some(poly => pointInRing_(lng, lat, poly[0]))) return String(z.zone_id);
  }
  return "";
}

function pointInRing_(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
