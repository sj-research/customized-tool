/**
 * 상권 조사 도구 API. 1단계: 읽기 전용
 *
 * 설치 위치: 구글 시트 cet_dongdaemun 의 확장 프로그램 > Apps Script
 * 이 코드에는 키, 토큰, 시트 주소가 없다. 토큰은 스크립트 속성 ACCESS_TOKEN 에 보관한다.
 *
 * 요청 방식
 *   POST, 본문은 JSON 문자열 { "token": "...", "action": "ping" | "data" }
 *   웹앱에서 fetch(url, { method: "POST", body: JSON.stringify(...) }) 로 호출한다
 *   Content-Type 헤더를 따로 붙이지 않는다. 붙이면 브라우저 사전 요청 때문에 막힐 수 있다
 */

const API_VERSION = "0.1";
const READ_SHEETS = ["zones", "places", "observations", "actions"];
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
          data: READ_SHEETS.reduce((acc, name) => {
            acc[name] = readSheet_(name);
            return acc;
          }, {}),
        });
      default:
        return json_({ ok: false, error: "unknown_action" });
    }
  } catch (err) {
    return json_({ ok: false, error: "server_error", message: String(err) });
  }
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
  READ_SHEETS.forEach(name => Logger.log(`${name}: ${readSheet_(name).length}행`));
}
