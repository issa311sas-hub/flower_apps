/**
 * 民泊清掃予定 自動割り当てシステム
 *
 * 使い方:
 *   1. このコードをGoogle スプレッドシートの Apps Script エディタに貼り付け
 *   2. スプレッドシートを再読み込みすると「清掃管理」メニューが表示される
 *   3.「初期設定」→ 設定シートにカレンダーIDを入力 → 予約データを貼り付け →「一括実行」
 */

// ============================================================
// 定数
// ============================================================
var SHEET_RESERVATIONS = '予約データ';
var SHEET_RESULTS      = '割り当て結果';
var SHEET_SETTINGS     = '設定';
var SYSTEM_TAG         = '[自動割当]';
var DAY_NAMES          = ['日', '月', '火', '水', '木', '金', '土'];

// ============================================================
// メニュー（スプレッドシートを開いたときに自動追加）
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧹 清掃管理')
    .addItem('▶ 一括実行（割り当て＋カレンダー反映）', 'runAll')
    .addSeparator()
    .addItem('割り当て実行のみ', 'runMatchingMenu')
    .addItem('カレンダー反映のみ', 'syncToCalendarMenu')
    .addSeparator()
    .addItem('⚙ 初期設定', 'setupSpreadsheet')
    .addToUi();
}

// ============================================================
// 初期設定: シート構造を作成
// ============================================================
function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ----- 設定シート -----
  var stg = getOrCreateSheet_(ss, SHEET_SETTINGS);
  stg.clear();

  // スタッフ情報
  stg.getRange('A1:B1').merge().setValue('■ スタッフ情報')
    .setFontWeight('bold').setBackground('#E8F0FA');
  stg.getRange('A2:B2').setValues([['スタッフ名', 'カレンダーID（出勤可否用）']])
    .setFontWeight('bold');
  stg.getRange('A3:B5').setValues([
    ['細田さん',   ''],
    ['普久原さん', ''],
    ['Rクリーン',  '']
  ]);
  stg.getRange('B3:B5').setFontColor('#999999')
    .setValues([['← カレンダーIDを入力'], ['← カレンダーIDを入力'], ['← カレンダーIDを入力']]);

  // 曜日別上限
  stg.getRange('A7:H7').merge().setValue('■ 曜日別 処理上限（件数）')
    .setFontWeight('bold').setBackground('#E4F4F0');
  stg.getRange('A8:H8').setValues([['スタッフ名', '月', '火', '水', '木', '金', '土', '日']])
    .setFontWeight('bold');
  stg.getRange('A9:H11').setValues([
    ['細田さん',   3, 3, 0, 3, 0, 0, 2],
    ['普久原さん', 0, 0, 3, 0, 3, 3, 0],
    ['Rクリーン',  99, 99, 99, 99, 99, 99, 99]
  ]);

  // 出力カレンダー
  stg.getRange('A13:B13').merge().setValue('■ 出力設定')
    .setFontWeight('bold').setBackground('#FBEAE6');
  stg.getRange('A14').setValue('割り当てカレンダーID');
  stg.getRange('B14').setValue('← カレンダーIDを入力').setFontColor('#999999');

  // 不可マーク
  stg.getRange('A16').setValue('不可マーク（カレンダーのイベント名）');
  stg.getRange('B16').setValue('×');

  stg.setColumnWidth(1, 220);
  stg.setColumnWidth(2, 380);
  for (var i = 3; i <= 8; i++) stg.setColumnWidth(i, 50);

  // ----- 予約データシート -----
  var res = getOrCreateSheet_(ss, SHEET_RESERVATIONS);
  res.clear();
  res.getRange('A1:D1')
    .setValues([['チェックアウト日', 'ユニット', 'ゲスト', '泊数']])
    .setFontWeight('bold').setBackground('#F0EBE3');
  res.getRange('A2').setValue('← Beds24 の Excel データをここに貼り付け（A2から）')
    .setFontColor('#999999');
  res.setColumnWidth(1, 150);
  res.setColumnWidth(2, 100);

  // ----- 割り当て結果シート -----
  var out = getOrCreateSheet_(ss, SHEET_RESULTS);
  out.clear();
  out.getRange('A1:E1')
    .setValues([['日付', '曜日', 'ユニット', '担当', 'ステータス']])
    .setFontWeight('bold').setBackground('#F0EBE3');

  // デフォルトシート削除
  removeDefaultSheet_(ss);

  SpreadsheetApp.getUi().alert(
    '初期設定が完了しました',
    '次の手順で進めてください:\n\n' +
    '1. 「設定」シートにカレンダーIDを入力\n' +
    '2. 「予約データ」シートにBeds24のExcelデータを貼り付け\n' +
    '3. 「清掃管理」メニュー → 一括実行',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ============================================================
// 設定読み込み
// ============================================================
function getSettings_() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!sheet) {
    throw new Error('設定シートがありません。「清掃管理 → 初期設定」を実行してください。');
  }

  var names   = sheet.getRange('A3:A5').getValues();
  var calIds  = sheet.getRange('B3:B5').getValues();
  var capData = sheet.getRange('B9:H11').getValues();
  var outCal  = sheet.getRange('B14').getValue();
  var mark    = sheet.getRange('B16').getValue() || '×';

  var staff = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i][0];
    if (!name) continue;
    var cap = {};
    // シートの列順: 月(=JS 1), 火(2), 水(3), 木(4), 金(5), 土(6), 日(0)
    cap[1] = Number(capData[i][0]) || 0;
    cap[2] = Number(capData[i][1]) || 0;
    cap[3] = Number(capData[i][2]) || 0;
    cap[4] = Number(capData[i][3]) || 0;
    cap[5] = Number(capData[i][4]) || 0;
    cap[6] = Number(capData[i][5]) || 0;
    cap[0] = Number(capData[i][6]) || 0;
    staff.push({ name: name, calendarId: String(calIds[i][0]).trim(), capacity: cap });
  }
  return { staff: staff, outputCalendarId: String(outCal).trim(), unavailMark: mark };
}

// ============================================================
// 予約データ読み込み
// ============================================================
function readReservations_() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_RESERVATIONS);
  if (!sheet) throw new Error('予約データシートがありません。');

  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];

  var data = sheet.getRange(1, 1, lastRow, 2).getValues();
  var results = [];
  var seen = {};

  for (var i = 0; i < data.length; i++) {
    var raw  = data[i][0];
    var unit = String(data[i][1]).trim();

    // ヘッダ行・空行・未割り当てをスキップ
    if (!raw || !unit) continue;
    if (String(raw).indexOf('チェックアウト') >= 0) continue;
    if (String(raw).indexOf('日付') >= 0) continue;
    if (unit === '未割り当て') continue;

    var date = toDate_(raw);
    if (!date) continue;

    // 同日同ユニットの重複排除
    var key = formatDate_(date) + '|' + unit;
    if (seen[key]) continue;
    seen[key] = true;

    results.push({ date: date, dateStr: formatDate_(date), unit: unit, dow: date.getDay() });
  }

  results.sort(function(a, b) { return a.date - b.date; });
  return results;
}

// ============================================================
// カレンダーから出勤不可日を取得
// ============================================================
function getUnavailDates_(calId, start, end, mark) {
  var set = {};
  if (!calId || calId.indexOf('カレンダーID') >= 0 || calId === '') return set;

  try {
    var cal = CalendarApp.getCalendarById(calId);
    if (!cal) return set;
    var events = cal.getEvents(start, end);

    for (var i = 0; i < events.length; i++) {
      var title = events[i].getTitle().trim();
      if (title === mark || title.indexOf(mark) >= 0) {
        if (events[i].isAllDayEvent()) {
          var s = events[i].getAllDayStartDate();
          var e = events[i].getAllDayEndDate();
          var d = new Date(s);
          while (d < e) {
            set[formatDate_(d)] = true;
            d.setDate(d.getDate() + 1);
          }
        } else {
          set[formatDate_(events[i].getStartTime())] = true;
        }
      }
    }
  } catch (err) {
    Logger.log('カレンダー読み取りエラー (' + calId + '): ' + err.message);
  }
  return set;
}

// ============================================================
// マッチングアルゴリズム（中核ロジック）
// ============================================================
function doMatching_() {
  var cfg = getSettings_();
  var reservations = readReservations_();
  if (reservations.length === 0) return [];

  // 日付範囲
  var minD = reservations[0].date;
  var maxD = reservations[reservations.length - 1].date;
  var rangeEnd = new Date(maxD);
  rangeEnd.setDate(rangeEnd.getDate() + 1);

  // 各スタッフの不可日
  var unavail = {};
  for (var s = 0; s < cfg.staff.length; s++) {
    unavail[cfg.staff[s].name] =
      getUnavailDates_(cfg.staff[s].calendarId, minD, rangeEnd, cfg.unavailMark);
  }

  // 日付ごとにグルーピング
  var byDate = {};
  for (var i = 0; i < reservations.length; i++) {
    var r = reservations[i];
    if (!byDate[r.dateStr]) {
      byDate[r.dateStr] = { date: r.date, dow: r.dow, units: [] };
    }
    byDate[r.dateStr].units.push(r.unit);
  }

  // 割り当て実行
  var assignments = [];
  var dateKeys = Object.keys(byDate).sort();

  for (var di = 0; di < dateKeys.length; di++) {
    var dk   = dateKeys[di];
    var info = byDate[dk];
    var dow  = info.dow;

    // この日の各スタッフの残り処理可能数を計算
    var remaining = {};
    for (var si = 0; si < cfg.staff.length; si++) {
      var st = cfg.staff[si];
      var isOff = unavail[st.name][dk] === true;
      remaining[st.name] = isOff ? 0 : (st.capacity[dow] || 0);
    }

    // 割り当て優先順: デフォルト担当(その曜日の上限が高い人) → もう1人 → Rクリーン
    var order = cfg.staff.slice().sort(function(a, b) {
      if (a.name === 'Rクリーン') return 1;
      if (b.name === 'Rクリーン') return -1;
      return (b.capacity[dow] || 0) - (a.capacity[dow] || 0);
    });

    for (var ui = 0; ui < info.units.length; ui++) {
      var unit = info.units[ui];
      var assigned = false;

      for (var oi = 0; oi < order.length; oi++) {
        var nm = order[oi].name;
        if (remaining[nm] > 0) {
          assignments.push({
            date: info.date, dateStr: dk, dayName: DAY_NAMES[dow],
            unit: unit, staff: nm,
            status: (nm === 'Rクリーン') ? '外注' : '確定'
          });
          remaining[nm]--;
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        assignments.push({
          date: info.date, dateStr: dk, dayName: DAY_NAMES[dow],
          unit: unit, staff: '未割当', status: '要確認'
        });
      }
    }
  }

  return assignments;
}

// ============================================================
// 結果をシートに書き込み
// ============================================================
function writeResults_(assignments) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SHEET_RESULTS);

  // ヘッダ以外クリア
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).clearContent().setBackground(null);
  }
  sheet.getRange('A1:E1')
    .setValues([['日付', '曜日', 'ユニット', '担当', 'ステータス']])
    .setFontWeight('bold').setBackground('#F0EBE3');

  if (assignments.length === 0) return;

  var rows = [];
  for (var i = 0; i < assignments.length; i++) {
    var a = assignments[i];
    rows.push([a.dateStr, a.dayName, a.unit, a.staff, a.status]);
  }
  sheet.getRange(2, 1, rows.length, 5).setValues(rows);

  // 担当者ごとの色分け
  var colors = {
    '細田さん':   '#E8F0FA',
    '普久原さん': '#FAF0E8',
    'Rクリーン':  '#F0E8FA',
    '未割当':     '#FBEAE6'
  };
  for (var j = 0; j < rows.length; j++) {
    var bg = colors[rows[j][3]] || '#FFFFFF';
    sheet.getRange(j + 2, 1, 1, 5).setBackground(bg);
  }
  sheet.autoResizeColumns(1, 5);
}

// ============================================================
// カレンダーに反映
// ============================================================
function doSyncToCalendar_() {
  var cfg   = getSettings_();
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_RESULTS);
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error('割り当て結果がありません。先に割り当てを実行してください。');
  }

  var calId = cfg.outputCalendarId;
  if (!calId || calId.indexOf('カレンダーID') >= 0) {
    throw new Error('設定シートに「割り当てカレンダーID」を入力してください。');
  }
  var cal = CalendarApp.getCalendarById(calId);
  if (!cal) {
    throw new Error('カレンダーが見つかりません。IDを確認してください: ' + calId);
  }

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();

  // 日付＋担当でグループ化 → 「細田さん⇒b4.b5」形式
  var grouped  = {};
  var minDate  = null;
  var maxDate  = null;

  for (var i = 0; i < data.length; i++) {
    var ds    = data[i][0];
    var staff = data[i][3];
    var unit  = data[i][2];
    if (!ds || !staff) continue;

    var key = ds + '|' + staff;
    if (!grouped[key]) grouped[key] = { dateStr: ds, staff: staff, units: [] };
    grouped[key].units.push(unit);

    var d = new Date(ds);
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }
  if (!minDate) return 0;

  // 既存の自動割当イベントを削除
  var searchEnd = new Date(maxDate);
  searchEnd.setDate(searchEnd.getDate() + 1);
  var existing = cal.getEvents(minDate, searchEnd);
  for (var e = 0; e < existing.length; e++) {
    var desc = existing[e].getDescription() || '';
    if (desc.indexOf(SYSTEM_TAG) >= 0) {
      existing[e].deleteEvent();
    }
  }

  // 新しいイベントを作成
  var count = 0;
  var keys  = Object.keys(grouped);
  for (var k = 0; k < keys.length; k++) {
    var g     = grouped[keys[k]];
    var title = g.staff + '⇒' + g.units.join('.');
    var evDate = new Date(g.dateStr);
    var ev    = cal.createAllDayEvent(title, evDate);
    ev.setDescription(
      SYSTEM_TAG + '\n自動割当システムにより作成\n' +
      '作成日時: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')
    );

    // イベントの色分け
    if (g.staff === '細田さん')     ev.setColor('1');  // 青
    if (g.staff === '普久原さん')   ev.setColor('6');  // オレンジ
    if (g.staff === 'Rクリーン')    ev.setColor('3');  // 紫

    count++;
  }
  return count;
}

// ============================================================
// メニューから呼ばれる関数
// ============================================================
function runMatchingMenu() {
  try {
    var assignments = doMatching_();
    if (assignments.length === 0) {
      showAlert_('予約データなし', '予約データシートにデータを貼り付けてください。');
      return;
    }
    writeResults_(assignments);

    var ext = countByStaff_(assignments, '外注');
    var msg = assignments.length + '件の清掃を割り当てました。\n' +
              '割り当て結果シートを確認してください。';
    if (ext > 0) msg += '\n\n⚠ Rクリーンへの外注: ' + ext + '件';
    showAlert_('割り当て完了', msg);
  } catch (e) {
    showAlert_('エラー', e.message);
  }
}

function syncToCalendarMenu() {
  try {
    var n = doSyncToCalendar_();
    showAlert_('カレンダー反映完了', n + '件の予定をカレンダーに書き込みました。');
  } catch (e) {
    showAlert_('エラー', e.message);
  }
}

function runAll() {
  try {
    var assignments = doMatching_();
    if (assignments.length === 0) {
      showAlert_('予約データなし', '予約データシートにデータを貼り付けてください。');
      return;
    }
    writeResults_(assignments);
    var calCount = doSyncToCalendar_();

    var ext = countByStaff_(assignments, '外注');
    var msg = '割り当て: ' + assignments.length + '件\n' +
              'カレンダー書き込み: ' + calCount + '件';
    if (ext > 0) msg += '\n\n⚠ Rクリーンへの外注が ' + ext + '件あります';
    showAlert_('一括実行完了', msg);
  } catch (e) {
    showAlert_('エラー', e.message);
  }
}

// ============================================================
// ユーティリティ
// ============================================================
function toDate_(val) {
  if (val instanceof Date) return val;
  var s = String(val).trim();
  // "15 7月 2026" 形式
  var m = {
    '1月':0,'2月':1,'3月':2,'4月':3,'5月':4,'6月':5,
    '7月':6,'8月':7,'9月':8,'10月':9,'11月':10,'12月':11
  };
  var parts = s.split(/\s+/);
  if (parts.length >= 3 && m[parts[1]] !== undefined) {
    return new Date(parseInt(parts[2]), m[parts[1]], parseInt(parts[0]));
  }
  // フォールバック: Date.parse
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd');
}

function countByStaff_(assignments, status) {
  var c = 0;
  for (var i = 0; i < assignments.length; i++) {
    if (assignments[i].status === status) c++;
  }
  return c;
}

function showAlert_(title, msg) {
  SpreadsheetApp.getUi().alert(title, msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

function getOrCreateSheet_(ss, name) {
  var s = ss.getSheetByName(name);
  if (!s) s = ss.insertSheet(name);
  return s;
}

function removeDefaultSheet_(ss) {
  var names = ['Sheet1', 'シート1'];
  for (var i = 0; i < names.length; i++) {
    var s = ss.getSheetByName(names[i]);
    if (s && ss.getSheets().length > 1) {
      try { ss.deleteSheet(s); } catch (e) { /* ignore */ }
    }
  }
}
