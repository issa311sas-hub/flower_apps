/**
 * 民泊清掃予定 自動割り当てシステム v2
 *
 * v1からの変更点:
 *   - カレンダー入力を ×/○ → 数字(0〜9) に変更（フェイルセーフ）
 *   - 半角・全角・丸付き数字に対応
 *   - 曜日固定の上限テーブルを廃止 → カレンダーの数字入力で都度決定
 *   - 優先割り当て＋均等化ロジック追加
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
// メニュー
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
// 初期設定
// ============================================================
function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ----- 設定シート -----
  var stg = getOrCreateSheet_(ss, SHEET_SETTINGS);
  stg.clear();

  // スタッフ情報
  stg.getRange('A1:C1').merge().setValue('■ スタッフ情報')
    .setFontWeight('bold').setBackground('#E8F0FA');
  stg.getRange('A2:C2')
    .setValues([['スタッフ名', 'カレンダーID（出勤可否用）', '未入力時デフォルト上限']])
    .setFontWeight('bold');
  stg.getRange('A3:C5').setValues([
    ['細田さん',   '', 0],
    ['普久原さん', '', 0],
    ['Rクリーン',  '', 99]
  ]);
  stg.getRange('B3:B5').setFontColor('#999999')
    .setValues([['← カレンダーIDを入力'], ['← カレンダーIDを入力'], ['← カレンダーIDを入力']]);
  stg.getRange('C2').setNote(
    'カレンダーに数字が未入力の日に適用される上限。\n' +
    '0 = 出勤不可（入れ忘れ防止）\n' +
    '99 = 常時対応可（Rクリーン向け）'
  );

  // 優先割り当てルール
  stg.getRange('A7:B7').merge().setValue('■ 優先割り当てルール')
    .setFontWeight('bold').setBackground('#E4F4F0');
  stg.getRange('A8:B11').setValues([
    ['優先スタッフ',         '細田さん'],
    ['対象曜日',             '月,火,木,日'],
    ['優先件数',             2],
    ['均等化しきい値（件）', 4]
  ]);
  stg.getRange('A8:A11').setFontWeight('bold');
  stg.getRange('B9').setNote('この曜日は優先スタッフに先に割り当て（カンマ区切り）');
  stg.getRange('B10').setNote('対象曜日で、この件数まで優先スタッフに割り当て');
  stg.getRange('B11').setNote('清掃がこの件数以上 かつ 両方出勤 なら均等に分配');

  // 出力設定
  stg.getRange('A13:B13').merge().setValue('■ 出力設定')
    .setFontWeight('bold').setBackground('#FBEAE6');
  stg.getRange('A14').setValue('割り当てカレンダーID').setFontWeight('bold');
  stg.getRange('B14').setValue('← カレンダーIDを入力').setFontColor('#999999');

  stg.setColumnWidth(1, 240);
  stg.setColumnWidth(2, 380);
  stg.setColumnWidth(3, 180);

  // ----- 予約データシート -----
  var res = getOrCreateSheet_(ss, SHEET_RESERVATIONS);
  res.clear();
  res.getRange('A1:D1')
    .setValues([['チェックアウト日', 'ユニット', 'ゲスト', '泊数']])
    .setFontWeight('bold').setBackground('#F0EBE3');
  res.getRange('A2').setValue('← Beds24 の Excel データをここに貼り付け（A1から上書きでもOK）')
    .setFontColor('#999999');
  res.setColumnWidth(1, 150);
  res.setColumnWidth(2, 100);

  // ----- 割り当て結果シート -----
  var out = getOrCreateSheet_(ss, SHEET_RESULTS);
  out.clear();
  out.getRange('A1:E1')
    .setValues([['日付', '曜日', 'ユニット', '担当', 'ステータス']])
    .setFontWeight('bold').setBackground('#F0EBE3');

  removeDefaultSheet_(ss);

  SpreadsheetApp.getUi().alert(
    '初期設定が完了しました',
    '次の手順で進めてください:\n\n' +
    '1. 「設定」シートにカレンダーIDを入力\n' +
    '2. スタッフに入力ルールを案内\n' +
    '   → カレンダーに終日イベントで数字を入力\n' +
    '   （例: 3 = 3件対応可能 / 0 = 出勤不可）\n' +
    '3. 「予約データ」シートにBeds24のExcelデータを貼り付け\n' +
    '4. 「清掃管理」メニュー → 一括実行',
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

  // スタッフ情報
  var names    = sheet.getRange('A3:A5').getValues();
  var calIds   = sheet.getRange('B3:B5').getValues();
  var defaults = sheet.getRange('C3:C5').getValues();

  var staff = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i][0];
    if (!name) continue;
    staff.push({
      name:       name,
      calendarId: String(calIds[i][0]).trim(),
      defaultCap: Number(defaults[i][0]) || 0
    });
  }

  // 優先ルール
  var priorityStaff     = String(sheet.getRange('B8').getValue()).trim();
  var priorityDaysStr   = String(sheet.getRange('B9').getValue()).trim();
  var priorityCount     = Number(sheet.getRange('B10').getValue()) || 2;
  var balanceThreshold  = Number(sheet.getRange('B11').getValue()) || 4;

  var dayMap = {'日':0,'月':1,'火':2,'水':3,'木':4,'金':5,'土':6};
  var priorityDays = {};
  var parts = priorityDaysStr.split(/[,、，\s]+/);
  for (var d = 0; d < parts.length; d++) {
    var dn = parts[d].trim();
    if (dayMap[dn] !== undefined) priorityDays[dayMap[dn]] = true;
  }

  // 出力カレンダー
  var outCal = String(sheet.getRange('B14').getValue()).trim();

  return {
    staff:             staff,
    priorityStaff:     priorityStaff,
    priorityDays:      priorityDays,
    priorityCount:     priorityCount,
    balanceThreshold:  balanceThreshold,
    outputCalendarId:  outCal
  };
}

// ============================================================
// 予約データ読み込み（v1と同一）
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

    if (!raw || !unit) continue;
    if (String(raw).indexOf('チェックアウト') >= 0) continue;
    if (String(raw).indexOf('日付') >= 0) continue;
    if (unit === '未割り当て') continue;

    var date = toDate_(raw);
    if (!date) continue;

    var key = formatDate_(date) + '|' + unit;
    if (seen[key]) continue;
    seen[key] = true;

    results.push({ date: date, dateStr: formatDate_(date), unit: unit, dow: date.getDay() });
  }

  results.sort(function(a, b) { return a.date - b.date; });
  return results;
}

// ============================================================
// カレンダーから日別の処理可能件数を取得（v2 新規）
// ============================================================
function getCapacityFromCalendar_(calId, startDate, endDate) {
  var caps = {};
  if (!calId || calId.indexOf('カレンダーID') >= 0 || calId === '') return caps;

  try {
    var cal = CalendarApp.getCalendarById(calId);
    if (!cal) return caps;
    var events = cal.getEvents(startDate, endDate);

    for (var i = 0; i < events.length; i++) {
      var title = events[i].getTitle().trim();
      var num = parseCapacityNumber_(title);
      if (num === null) continue;

      if (events[i].isAllDayEvent()) {
        var s = events[i].getAllDayStartDate();
        var e = events[i].getAllDayEndDate();
        var d = new Date(s);
        while (d < e) {
          caps[formatDate_(d)] = num;
          d.setDate(d.getDate() + 1);
        }
      } else {
        caps[formatDate_(events[i].getStartTime())] = num;
      }
    }
  } catch (err) {
    Logger.log('カレンダー読み取りエラー (' + calId + '): ' + err.message);
  }
  return caps;
}

// 半角・全角・丸付き数字 → 数値に変換
function parseCapacityNumber_(str) {
  if (!str || str.length === 0) return null;
  var c = str.charAt(0);

  var hw = '0123456789';
  var idx = hw.indexOf(c);
  if (idx >= 0) return idx;

  var fw = ['０','１','２','３','４','５','６','７','８','９'];
  for (var i = 0; i < fw.length; i++) {
    if (c === fw[i]) return i;
  }

  var ci = ['⓪','①','②','③','④','⑤','⑥','⑦','⑧','⑨'];
  for (var j = 0; j < ci.length; j++) {
    if (c === ci[j]) return j;
  }

  return null;
}

// そのスタッフのその日の処理可能件数を返す
function getCapForDate_(staffCaps, staffInfo, dateStr) {
  var caps = staffCaps[staffInfo.name];
  if (caps && caps[dateStr] !== undefined) return caps[dateStr];
  return staffInfo.defaultCap;
}

// ============================================================
// マッチングアルゴリズム（v2 全面改修）
//
// ルール:
//   1. 各スタッフの処理可能件数はカレンダーの数字で決まる
//      （未入力 = デフォルト上限。スタッフは0、Rクリーンは99）
//   2. 優先曜日(月火木日) かつ 3件以下 → 優先スタッフに2件まで先に割り当て
//   3. 優先曜日 かつ 4件以上 かつ 両者出勤 → 均等に分配
//   4. 非優先曜日(水金土) → 非優先スタッフを先に割り当て
//   5. どちらも対応不可な分 → Rクリーン
// ============================================================
function doMatching_() {
  var cfg = getSettings_();
  var reservations = readReservations_();
  if (reservations.length === 0) return [];

  var minD = reservations[0].date;
  var maxD = reservations[reservations.length - 1].date;
  var rangeEnd = new Date(maxD);
  rangeEnd.setDate(rangeEnd.getDate() + 1);

  // カレンダーから各スタッフの日別処理可能件数を取得
  var staffCaps = {};
  for (var s = 0; s < cfg.staff.length; s++) {
    staffCaps[cfg.staff[s].name] =
      getCapacityFromCalendar_(cfg.staff[s].calendarId, minD, rangeEnd);
  }

  // 優先スタッフ / 他スタッフ / Rクリーン を特定
  var priInfo = null, othInfo = null, rclInfo = null;
  for (var si = 0; si < cfg.staff.length; si++) {
    if (cfg.staff[si].name === cfg.priorityStaff) priInfo = cfg.staff[si];
    else if (cfg.staff[si].name === 'Rクリーン')  rclInfo = cfg.staff[si];
    else                                           othInfo = cfg.staff[si];
  }
  if (!priInfo || !othInfo) {
    throw new Error('設定シートのスタッフ名と優先スタッフ名が一致しません。');
  }

  // 日付ごとにグルーピング
  var byDate = {};
  for (var i = 0; i < reservations.length; i++) {
    var r = reservations[i];
    if (!byDate[r.dateStr]) byDate[r.dateStr] = { date: r.date, dow: r.dow, units: [] };
    byDate[r.dateStr].units.push(r.unit);
  }

  // 日付ごとに割り当て
  var assignments = [];
  var dateKeys = Object.keys(byDate).sort();

  for (var di = 0; di < dateKeys.length; di++) {
    var dk   = dateKeys[di];
    var info = byDate[dk];
    var total = info.units.length;
    var dow  = info.dow;

    var priCap = getCapForDate_(staffCaps, priInfo, dk);
    var othCap = getCapForDate_(staffCaps, othInfo, dk);
    var rclCap = rclInfo ? getCapForDate_(staffCaps, rclInfo, dk) : 99;

    var priAlloc = 0, othAlloc = 0, rclAlloc = 0;
    var isPriorityDay = cfg.priorityDays[dow] === true;

    if (isPriorityDay) {
      if (total >= cfg.balanceThreshold && priCap > 0 && othCap > 0) {
        // 均等分配: 端数は優先スタッフへ
        var priTarget = Math.ceil(total / 2);
        var othTarget = total - priTarget;
        priAlloc = Math.min(priTarget, priCap);
        othAlloc = Math.min(othTarget + (priTarget - priAlloc), othCap);
      } else {
        // 優先スタッフに priorityCount 件まで先に割り当て
        priAlloc = Math.min(cfg.priorityCount, priCap, total);
        var rem = total - priAlloc;
        othAlloc = Math.min(rem, othCap);
      }
    } else {
      // 非優先曜日: 他スタッフが先
      othAlloc = Math.min(total, othCap);
      var rem2 = total - othAlloc;
      priAlloc = Math.min(rem2, priCap);
    }

    rclAlloc = Math.min(total - priAlloc - othAlloc, rclCap);
    var unassigned = total - priAlloc - othAlloc - rclAlloc;

    // ユニットを各担当に振り分け
    var unitIdx = 0;
    var first  = isPriorityDay ? priInfo : othInfo;
    var second = isPriorityDay ? othInfo : priInfo;
    var firstN  = isPriorityDay ? priAlloc : othAlloc;
    var secondN = isPriorityDay ? othAlloc : priAlloc;

    for (var a = 0; a < firstN; a++, unitIdx++) {
      assignments.push(makeAssign_(info, dk, dow, info.units[unitIdx], first.name));
    }
    for (var b = 0; b < secondN; b++, unitIdx++) {
      assignments.push(makeAssign_(info, dk, dow, info.units[unitIdx], second.name));
    }
    for (var c = 0; c < rclAlloc; c++, unitIdx++) {
      assignments.push(makeAssign_(info, dk, dow, info.units[unitIdx], rclInfo ? rclInfo.name : 'Rクリーン'));
    }
    for (var u = 0; u < unassigned; u++, unitIdx++) {
      assignments.push({
        date: info.date, dateStr: dk, dayName: DAY_NAMES[dow],
        unit: info.units[unitIdx], staff: '未割当', status: '要確認'
      });
    }
  }

  return assignments;
}

function makeAssign_(info, dk, dow, unit, staffName) {
  return {
    date: info.date, dateStr: dk, dayName: DAY_NAMES[dow],
    unit: unit, staff: staffName,
    status: (staffName === 'Rクリーン') ? '外注' : '確定'
  };
}

// ============================================================
// 結果をシートに書き込み（v1と同一）
// ============================================================
function writeResults_(assignments) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SHEET_RESULTS);

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
// カレンダーに反映（v1と同一）
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

  var searchEnd = new Date(maxDate);
  searchEnd.setDate(searchEnd.getDate() + 1);
  var existing = cal.getEvents(minDate, searchEnd);
  for (var e = 0; e < existing.length; e++) {
    var desc = existing[e].getDescription() || '';
    if (desc.indexOf(SYSTEM_TAG) >= 0) {
      existing[e].deleteEvent();
    }
  }

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

    if (g.staff === '細田さん')     ev.setColor('1');
    if (g.staff === '普久原さん')   ev.setColor('6');
    if (g.staff === 'Rクリーン')    ev.setColor('3');

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

    var ext = countByStatus_(assignments, '外注');
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

    var ext = countByStatus_(assignments, '外注');
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
  var m = {
    '1月':0,'2月':1,'3月':2,'4月':3,'5月':4,'6月':5,
    '7月':6,'8月':7,'9月':8,'10月':9,'11月':10,'12月':11
  };
  var parts = s.split(/\s+/);
  if (parts.length >= 3 && m[parts[1]] !== undefined) {
    return new Date(parseInt(parts[2]), m[parts[1]], parseInt(parts[0]));
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd');
}

function countByStatus_(assignments, status) {
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
      try { ss.deleteSheet(s); } catch (e) {}
    }
  }
}
