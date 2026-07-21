/**
 * 民泊清掃予定 自動割り当てシステム v4
 *
 * v3からの変更点:
 *   - 「翌日清掃」ルール追加: タイトルに「翌日清掃」を含む予約は
 *     当日スタッフ不足時、翌日のスタッフに回して外注を回避する
 *   - DBに「清掃日」列を追加（チェックアウト日と清掃日を分離管理）
 */

// ============================================================
// 定数
// ============================================================
var SHEET_RESERVATIONS = '予約データ';
var SHEET_RESULTS      = '割り当て結果';
var SHEET_SETTINGS     = '設定';
var SHEET_DB           = '同期データベース';
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
    .setValues([['予約ID', 'タイトル', 'チェックアウト日', 'ユニット']])
    .setFontWeight('bold').setBackground('#F0EBE3');
  res.getRange('A2').setValue('← Beds24 の Excel データをここに貼り付け（A1から上書きでもOK）')
    .setFontColor('#999999');
  res.setColumnWidth(1, 120);
  res.setColumnWidth(2, 200);
  res.setColumnWidth(3, 150);
  res.setColumnWidth(4, 100);

  // ----- 割り当て結果シート -----
  var out = getOrCreateSheet_(ss, SHEET_RESULTS);
  out.clear();
  out.getRange('A1:G1')
    .setValues([['予約ID', '日付', '曜日', 'ユニット', 'タイトル', '担当', 'ステータス']])
    .setFontWeight('bold').setBackground('#F0EBE3');

  // ----- 同期データベースシート -----
  var db = getOrCreateSheet_(ss, SHEET_DB);
  db.clear();
  db.getRange('A1:H1')
    .setValues([['予約ID', 'チェックアウト日', '清掃日', 'ユニット', 'タイトル', '担当', 'イベントID', '最終同期']])
    .setFontWeight('bold').setBackground('#E3E8F0');
  db.setTabColor('#999999');
  db.getRange('A2').setValue('※ このシートはシステムが自動管理します。手動で編集しないでください。')
    .setFontColor('#999999');
  db.setColumnWidth(1, 120);
  db.setColumnWidth(2, 130);
  db.setColumnWidth(3, 130);
  db.setColumnWidth(4, 80);
  db.setColumnWidth(5, 150);
  db.setColumnWidth(6, 100);
  db.setColumnWidth(7, 280);
  db.setColumnWidth(8, 150);

  removeDefaultSheet_(ss);

  SpreadsheetApp.getUi().alert(
    '初期設定が完了しました',
    '次の手順で進めてください:\n\n' +
    '1. 「設定」シートにカレンダーIDを入力\n' +
    '2. スタッフに入力ルールを案内\n' +
    '   → カレンダーに終日イベントで数字を入力\n' +
    '   （例: 3 = 3件対応可能 / 0 = 出勤不可）\n' +
    '3. 「予約データ」シートにExcelデータを貼り付け\n' +
    '   （形式: 予約ID, タイトル, チェックアウト日, ユニット）\n' +
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
// 予約データ読み込み
// ============================================================
function readReservations_() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_RESERVATIONS);
  if (!sheet) throw new Error('予約データシートがありません。');

  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];

  var data = sheet.getRange(1, 1, lastRow, 4).getValues();
  var results = [];
  var seen = {};

  for (var i = 0; i < data.length; i++) {
    var bookingId = String(data[i][0]).trim();
    var title     = String(data[i][1]).trim();
    var rawDate   = data[i][2];
    var unit      = String(data[i][3]).trim();

    if (!bookingId || !unit) continue;
    if (bookingId === '予約ID') continue;
    if (String(rawDate).indexOf('チェックアウト') >= 0) continue;
    if (!/^\d+$/.test(bookingId)) continue;

    var date = toDate_(rawDate);
    if (!date) continue;

    if (seen[bookingId]) continue;
    seen[bookingId] = true;

    results.push({
      bookingId: bookingId,
      title:     title || '',
      date:      date,
      dateStr:   formatDate_(date),
      unit:      unit,
      dow:       date.getDay()
    });
  }

  results.sort(function(a, b) { return a.date - b.date; });
  return results;
}

// ============================================================
// 同期データベース読み書き（v4: 8列、清掃日を分離）
// ============================================================
function readDatabase_() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_DB);
  if (!sheet || sheet.getLastRow() < 2) return {};

  var cols = Math.min(sheet.getLastColumn(), 8);
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols).getValues();
  var db = {};

  for (var i = 0; i < data.length; i++) {
    var bid = String(data[i][0]).trim();
    if (!bid || !/^\d+$/.test(bid)) continue;

    if (cols >= 8) {
      db[bid] = {
        bookingId:       bid,
        checkoutDateStr: String(data[i][1]).trim(),
        cleaningDateStr: String(data[i][2]).trim(),
        unit:            String(data[i][3]).trim(),
        title:           String(data[i][4]).trim(),
        staff:           String(data[i][5]).trim(),
        eventId:         String(data[i][6]).trim(),
        lastSync:        data[i][7]
      };
    } else {
      db[bid] = {
        bookingId:       bid,
        checkoutDateStr: String(data[i][1]).trim(),
        cleaningDateStr: String(data[i][1]).trim(),
        unit:            String(data[i][2]).trim(),
        title:           String(data[i][3]).trim(),
        staff:           String(data[i][4]).trim(),
        eventId:         String(data[i][5]).trim(),
        lastSync:        data[i][6]
      };
    }
  }
  return db;
}

function writeDatabase_(records) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SHEET_DB);

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).clearContent();
  }
  sheet.getRange('A1:H1')
    .setValues([['予約ID', 'チェックアウト日', '清掃日', 'ユニット', 'タイトル', '担当', 'イベントID', '最終同期']])
    .setFontWeight('bold').setBackground('#E3E8F0');

  var keys = Object.keys(records);
  if (keys.length === 0) return;

  keys.sort();
  var rows = [];
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

  for (var i = 0; i < keys.length; i++) {
    var r = records[keys[i]];
    rows.push([
      r.bookingId,
      r.checkoutDateStr,
      r.cleaningDateStr || r.checkoutDateStr,
      r.unit, r.title, r.staff,
      r.eventId || '',
      r.lastSync || now
    ]);
  }

  sheet.getRange(2, 1, rows.length, 8).setValues(rows);
}

// ============================================================
// 差分計算（v4: チェックアウト日で比較）
// ============================================================
function computeDiff_(reservations, db) {
  var newIds = {};
  var added     = [];
  var changed   = [];
  var unchanged = [];

  for (var i = 0; i < reservations.length; i++) {
    var r = reservations[i];
    newIds[r.bookingId] = true;

    var prev = db[r.bookingId];
    if (!prev) {
      added.push(r);
    } else if (prev.checkoutDateStr !== r.dateStr || prev.unit !== r.unit || prev.title !== r.title) {
      changed.push({ newData: r, oldData: prev });
    } else {
      unchanged.push({ newData: r, oldData: prev });
    }
  }

  var removed = [];
  var dbKeys = Object.keys(db);
  for (var j = 0; j < dbKeys.length; j++) {
    if (!newIds[dbKeys[j]]) {
      removed.push(db[dbKeys[j]]);
    }
  }

  return { added: added, changed: changed, unchanged: unchanged, removed: removed };
}

// ============================================================
// カレンダーから処理可能件数を取得
// ============================================================
function getCapacityForDates_(calId, dateStrs) {
  var caps = {};
  if (!calId || calId.indexOf('カレンダーID') >= 0 || calId === '') return caps;
  if (dateStrs.length === 0) return caps;

  var dates = [];
  for (var i = 0; i < dateStrs.length; i++) {
    dates.push(parseDateStr_(dateStrs[i]));
  }

  var minDate = dates[0], maxDate = dates[0];
  for (var d = 1; d < dates.length; d++) {
    if (dates[d] < minDate) minDate = dates[d];
    if (dates[d] > maxDate) maxDate = dates[d];
  }

  var rangeEnd = new Date(maxDate);
  rangeEnd.setDate(rangeEnd.getDate() + 1);

  var neededSet = {};
  for (var n = 0; n < dateStrs.length; n++) neededSet[dateStrs[n]] = true;

  try {
    var cal = CalendarApp.getCalendarById(calId);
    if (!cal) return caps;
    var events = cal.getEvents(minDate, rangeEnd);

    for (var e = 0; e < events.length; e++) {
      var title = events[e].getTitle().trim();
      var num = parseCapacityNumber_(title);
      if (num === null) continue;

      if (events[e].isAllDayEvent()) {
        var s   = events[e].getAllDayStartDate();
        var end = events[e].getAllDayEndDate();
        var dt  = new Date(s);
        while (dt < end) {
          var ds = formatDate_(dt);
          if (neededSet[ds]) caps[ds] = num;
          dt.setDate(dt.getDate() + 1);
        }
      } else {
        var ds2 = formatDate_(events[e].getStartTime());
        if (neededSet[ds2]) caps[ds2] = num;
      }
    }
  } catch (err) {
    Logger.log('カレンダー読み取りエラー (' + calId + '): ' + err.message);
  }
  return caps;
}

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

function getCapForDate_(staffCaps, staffInfo, dateStr) {
  var caps = staffCaps[staffInfo.name];
  if (caps && caps[dateStr] !== undefined) return caps[dateStr];
  return staffInfo.defaultCap;
}

// ============================================================
// マッチングアルゴリズム（v4: 翌日清掃ルール追加）
//
// Phase 1: 通常の割り当て（既存保持 + 新規割り当て）
// Phase 2: 翌日清掃の延期処理
//   - Rクリーン/未割当に回った「翌日清掃」予約を翌日スタッフに振り替え
//   - 当日スタッフで対応可能ならそのまま当日（Phase 1で割り当て済み）
// ============================================================
function doMatching_() {
  var cfg = getSettings_();
  var reservations = readReservations_();
  if (reservations.length === 0) return [];

  var db   = readDatabase_();
  var diff = computeDiff_(reservations, db);

  // スタッフ情報を特定
  var priInfo = null, othInfo = null, rclInfo = null;
  for (var si = 0; si < cfg.staff.length; si++) {
    if (cfg.staff[si].name === cfg.priorityStaff) priInfo = cfg.staff[si];
    else if (cfg.staff[si].name === 'Rクリーン')  rclInfo = cfg.staff[si];
    else                                           othInfo = cfg.staff[si];
  }
  if (!priInfo || !othInfo) {
    throw new Error('設定シートのスタッフ名と優先スタッフ名が一致しません。');
  }

  // --- 全割り当ての使用量を追跡 ---
  var usageByDate = {};
  var allAssignments = [];

  // --- 既存割り当てを保持（清掃日ベース） ---
  for (var u = 0; u < diff.unchanged.length; u++) {
    var uc = diff.unchanged[u];
    var cds = uc.oldData.cleaningDateStr || uc.newData.dateStr;
    var cleaningDate = parseDateStr_(cds);
    var cleaningDow  = cleaningDate.getDay();

    var a = {
      bookingId:       uc.newData.bookingId,
      checkoutDateStr: uc.newData.dateStr,
      date:            cleaningDate,
      dateStr:         cds,
      dayName:         DAY_NAMES[cleaningDow],
      unit:            uc.newData.unit,
      title:           uc.newData.title,
      staff:           uc.oldData.staff,
      status:          uc.oldData.staff === 'Rクリーン' ? '外注' :
                       (uc.oldData.staff === '未割当' ? '要確認' :
                       (cds !== uc.newData.dateStr ? '確定（翌日）' : '確定'))
    };
    allAssignments.push(a);

    if (!usageByDate[cds]) usageByDate[cds] = {};
    usageByDate[cds][a.staff] = (usageByDate[cds][a.staff] || 0) + 1;
  }

  // --- 新規＋変更分を割り当て ---
  var toAssign = [];
  for (var ad = 0; ad < diff.added.length; ad++)   toAssign.push(diff.added[ad]);
  for (var ch = 0; ch < diff.changed.length; ch++) toAssign.push(diff.changed[ch].newData);

  var staffCaps = {};
  if (toAssign.length > 0) {
    // 必要な日付を収集（翌日清掃の翌日分も含む）
    var datesNeeded = {};
    for (var t = 0; t < toAssign.length; t++) {
      datesNeeded[toAssign[t].dateStr] = true;
      if (toAssign[t].title && toAssign[t].title.indexOf('翌日清掃') >= 0) {
        var nd = new Date(toAssign[t].date);
        nd.setDate(nd.getDate() + 1);
        datesNeeded[formatDate_(nd)] = true;
      }
    }
    var datesToCheck = Object.keys(datesNeeded);

    for (var s = 0; s < cfg.staff.length; s++) {
      staffCaps[cfg.staff[s].name] =
        getCapacityForDates_(cfg.staff[s].calendarId, datesToCheck);
    }

    // Phase 1: 日付ごとの通常割り当て
    var newByDate = {};
    for (var nb = 0; nb < toAssign.length; nb++) {
      var r = toAssign[nb];
      if (!newByDate[r.dateStr]) newByDate[r.dateStr] = { date: r.date, dow: r.dow, items: [] };
      newByDate[r.dateStr].items.push(r);
    }

    var dateKeys = Object.keys(newByDate).sort();
    for (var di = 0; di < dateKeys.length; di++) {
      var dk       = dateKeys[di];
      var info     = newByDate[dk];
      var dow      = info.dow;
      var newItems = info.items;
      var total    = newItems.length;

      var priTotalCap = getCapForDate_(staffCaps, priInfo, dk);
      var othTotalCap = getCapForDate_(staffCaps, othInfo, dk);
      var rclTotalCap = rclInfo ? getCapForDate_(staffCaps, rclInfo, dk) : 99;

      var eu       = usageByDate[dk] || {};
      var existPri = eu[priInfo.name] || 0;
      var existOth = eu[othInfo.name] || 0;
      var existRcl = eu[rclInfo ? rclInfo.name : 'Rクリーン'] || 0;

      var priRemain = Math.max(0, priTotalCap - existPri);
      var othRemain = Math.max(0, othTotalCap - existOth);
      var rclRemain = Math.max(0, rclTotalCap - existRcl);

      var totalDayWork  = total + existPri + existOth + existRcl;
      var isPriorityDay = cfg.priorityDays[dow] === true;

      var priAlloc = 0, othAlloc = 0, rclAlloc = 0;

      if (isPriorityDay) {
        if (totalDayWork >= cfg.balanceThreshold && priTotalCap > 0 && othTotalCap > 0) {
          var targetPri = Math.ceil(totalDayWork / 2);
          var targetOth = totalDayWork - targetPri;
          priAlloc = Math.min(Math.max(0, targetPri - existPri), priRemain, total);
          othAlloc = Math.min(Math.max(0, targetOth - existOth), othRemain, total - priAlloc);
        } else {
          var priTarget = Math.max(0, cfg.priorityCount - existPri);
          priAlloc = Math.min(priTarget, priRemain, total);
          othAlloc = Math.min(total - priAlloc, othRemain);
        }
      } else {
        othAlloc = Math.min(total, othRemain);
        priAlloc = Math.min(total - othAlloc, priRemain);
      }

      rclAlloc = Math.min(total - priAlloc - othAlloc, rclRemain);
      var unassignedN = total - priAlloc - othAlloc - rclAlloc;

      var unitIdx = 0;
      var first   = isPriorityDay ? priInfo : othInfo;
      var second  = isPriorityDay ? othInfo : priInfo;
      var firstN  = isPriorityDay ? priAlloc : othAlloc;
      var secondN = isPriorityDay ? othAlloc : priAlloc;

      for (var a1 = 0; a1 < firstN; a1++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], first.name));
        addUsage_(usageByDate, dk, first.name);
      }
      for (var a2 = 0; a2 < secondN; a2++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], second.name));
        addUsage_(usageByDate, dk, second.name);
      }
      for (var a3 = 0; a3 < rclAlloc; a3++, unitIdx++) {
        var rclName = rclInfo ? rclInfo.name : 'Rクリーン';
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], rclName));
        addUsage_(usageByDate, dk, rclName);
      }
      for (var a4 = 0; a4 < unassignedN; a4++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], '未割当'));
        addUsage_(usageByDate, dk, '未割当');
      }
    }

    // --------------------------------------------------------
    // Phase 2: 翌日清掃の延期処理
    //
    // Rクリーン or 未割当に回った「翌日清掃」予約について、
    // 翌日のスタッフ残容量を確認し、可能なら翌日に回す。
    // --------------------------------------------------------
    var deferCount = 0;
    for (var df = 0; df < allAssignments.length; df++) {
      var asgn = allAssignments[df];
      if (asgn.staff !== 'Rクリーン' && asgn.staff !== '未割当') continue;
      if (!asgn.title || asgn.title.indexOf('翌日清掃') < 0) continue;
      if (asgn.checkoutDateStr !== asgn.dateStr) continue;

      var nextDate = new Date(asgn.date);
      nextDate.setDate(nextDate.getDate() + 1);
      var nextDateStr = formatDate_(nextDate);
      var nextDow     = nextDate.getDay();

      var priCapNext = getCapForDate_(staffCaps, priInfo, nextDateStr);
      var othCapNext = getCapForDate_(staffCaps, othInfo, nextDateStr);

      var euNext     = usageByDate[nextDateStr] || {};
      var priUsedN   = euNext[priInfo.name] || 0;
      var othUsedN   = euNext[othInfo.name] || 0;
      var priRemainN = Math.max(0, priCapNext - priUsedN);
      var othRemainN = Math.max(0, othCapNext - othUsedN);

      var isPriDayNext = cfg.priorityDays[nextDow] === true;
      var deferTo = null;

      if (isPriDayNext) {
        if (priRemainN > 0)      deferTo = priInfo.name;
        else if (othRemainN > 0) deferTo = othInfo.name;
      } else {
        if (othRemainN > 0)      deferTo = othInfo.name;
        else if (priRemainN > 0) deferTo = priInfo.name;
      }

      if (deferTo) {
        var origDate = asgn.dateStr;
        var origStaff = asgn.staff;

        asgn.date    = nextDate;
        asgn.dateStr = nextDateStr;
        asgn.dayName = DAY_NAMES[nextDow];
        asgn.staff   = deferTo;
        asgn.status  = '確定（翌日）';

        addUsage_(usageByDate, nextDateStr, deferTo);
        if (usageByDate[origDate] && usageByDate[origDate][origStaff]) {
          usageByDate[origDate][origStaff]--;
        }
        deferCount++;
      }
    }
  }

  allAssignments.sort(function(a, b) {
    if (a.dateStr !== b.dateStr) return a.dateStr < b.dateStr ? -1 : 1;
    if (a.unit !== b.unit)       return a.unit < b.unit ? -1 : 1;
    return 0;
  });

  return allAssignments;
}

function makeAssignFromBooking_(booking, staffName) {
  return {
    bookingId:       booking.bookingId,
    checkoutDateStr: booking.dateStr,
    date:            booking.date,
    dateStr:         booking.dateStr,
    dayName:         DAY_NAMES[booking.dow],
    unit:            booking.unit,
    title:           booking.title,
    staff:           staffName,
    status:          statusFor_(staffName)
  };
}

function addUsage_(usageByDate, dateStr, staffName) {
  if (!usageByDate[dateStr]) usageByDate[dateStr] = {};
  usageByDate[dateStr][staffName] = (usageByDate[dateStr][staffName] || 0) + 1;
}

function statusFor_(staffName) {
  if (staffName === 'Rクリーン') return '外注';
  if (staffName === '未割当')    return '要確認';
  return '確定';
}

// ============================================================
// 結果をシートに書き込み
// ============================================================
function writeResults_(assignments) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SHEET_RESULTS);

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).clearContent().setBackground(null);
  }
  sheet.getRange('A1:G1')
    .setValues([['予約ID', '日付', '曜日', 'ユニット', 'タイトル', '担当', 'ステータス']])
    .setFontWeight('bold').setBackground('#F0EBE3');

  if (assignments.length === 0) return;

  var rows = [];
  for (var i = 0; i < assignments.length; i++) {
    var a = assignments[i];
    rows.push([a.bookingId, a.dateStr, a.dayName, a.unit, a.title, a.staff, a.status]);
  }
  sheet.getRange(2, 1, rows.length, 7).setValues(rows);

  var colors = {
    '細田さん':   '#E8F0FA',
    '普久原さん': '#FAF0E8',
    'Rクリーン':  '#F0E8FA',
    '未割当':     '#FBEAE6'
  };
  for (var j = 0; j < rows.length; j++) {
    var bg = colors[rows[j][5]] || '#FFFFFF';
    sheet.getRange(j + 2, 1, 1, 7).setBackground(bg);
  }
  sheet.autoResizeColumns(1, 7);
}

// ============================================================
// カレンダーに差分反映（v4: 清掃日ベースで同期）
// ============================================================
function doSyncToCalendar_() {
  var cfg = getSettings_();
  var ss  = SpreadsheetApp.getActiveSpreadsheet();

  var resultSheet = ss.getSheetByName(SHEET_RESULTS);
  if (!resultSheet || resultSheet.getLastRow() < 2) {
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

  var db = readDatabase_();
  var resultData = resultSheet.getRange(2, 1, resultSheet.getLastRow() - 1, 7).getValues();

  // 予約データからチェックアウト日を取得
  var reservations = readReservations_();
  var resLookup = {};
  for (var rl = 0; rl < reservations.length; rl++) {
    resLookup[reservations[rl].bookingId] = reservations[rl];
  }

  // 割り当て結果シートから現在の状態を構築
  var current = {};
  for (var i = 0; i < resultData.length; i++) {
    var bid = String(resultData[i][0]).trim();
    if (!bid || !/^\d+$/.test(bid)) continue;

    var cleaningDateStr = String(resultData[i][1]).trim();
    var checkoutDateStr = resLookup[bid] ? resLookup[bid].dateStr : cleaningDateStr;

    current[bid] = {
      bookingId:       bid,
      checkoutDateStr: checkoutDateStr,
      cleaningDateStr: cleaningDateStr,
      unit:            String(resultData[i][3]).trim(),
      title:           String(resultData[i][4]).trim(),
      staff:           String(resultData[i][5]).trim()
    };
  }

  var toDelete = [];
  var toCreate = [];
  var newDb    = {};

  // DB既存分を確認（清掃日・担当等で比較）
  var dbKeys = Object.keys(db);
  for (var d = 0; d < dbKeys.length; d++) {
    var dbBid  = dbKeys[d];
    var dbRec  = db[dbBid];
    var curRec = current[dbBid];

    if (!curRec) {
      if (dbRec.eventId) toDelete.push(dbRec);
    } else if (dbRec.cleaningDateStr !== curRec.cleaningDateStr ||
               dbRec.unit !== curRec.unit || dbRec.title !== curRec.title ||
               dbRec.staff !== curRec.staff) {
      if (dbRec.eventId) toDelete.push(dbRec);
      toCreate.push(curRec);
      newDb[dbBid] = {
        bookingId: dbBid, checkoutDateStr: curRec.checkoutDateStr,
        cleaningDateStr: curRec.cleaningDateStr, unit: curRec.unit,
        title: curRec.title, staff: curRec.staff, eventId: '', lastSync: ''
      };
    } else {
      newDb[dbBid] = dbRec;
    }
  }

  // 新規分を確認
  var curKeys = Object.keys(current);
  for (var c = 0; c < curKeys.length; c++) {
    var curBid = curKeys[c];
    if (!db[curBid]) {
      toCreate.push(current[curBid]);
      newDb[curBid] = {
        bookingId: curBid, checkoutDateStr: current[curBid].checkoutDateStr,
        cleaningDateStr: current[curBid].cleaningDateStr, unit: current[curBid].unit,
        title: current[curBid].title, staff: current[curBid].staff, eventId: '', lastSync: ''
      };
    }
  }

  // イベント削除
  var deleted = 0;
  for (var del = 0; del < toDelete.length; del++) {
    try {
      var ev = cal.getEventById(toDelete[del].eventId);
      if (ev) { ev.deleteEvent(); deleted++; }
    } catch (err) {
      Logger.log('イベント削除エラー (' + toDelete[del].eventId + '): ' + err.message);
    }
  }

  // イベント作成（清掃日に作成）
  var created = 0;
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

  for (var cr = 0; cr < toCreate.length; cr++) {
    var rec = toCreate[cr];
    if (rec.staff === '未割当') continue;

    var evTitle = rec.title
      ? rec.staff + '⇒' + rec.unit + '(' + rec.title + ')'
      : rec.staff + '⇒' + rec.unit;
    var evDate = parseDateStr_(rec.cleaningDateStr);

    try {
      var newEv = cal.createAllDayEvent(evTitle, evDate);
      newEv.setDescription(
        SYSTEM_TAG + '\n予約ID: ' + rec.bookingId + '\n' +
        '自動割当システムにより作成\n作成日時: ' + now
      );

      if (rec.staff === '細田さん')   newEv.setColor('1');
      if (rec.staff === '普久原さん') newEv.setColor('6');
      if (rec.staff === 'Rクリーン')  newEv.setColor('3');

      newDb[rec.bookingId].eventId  = newEv.getId();
      newDb[rec.bookingId].lastSync = now;
      created++;
    } catch (err) {
      Logger.log('イベント作成エラー: ' + err.message);
    }
  }

  writeDatabase_(newDb);
  return { created: created, deleted: deleted };
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

    var ext  = countByStatus_(assignments, '外注');
    var una  = countByStatus_(assignments, '要確認');
    var defr = countByStatus_(assignments, '確定（翌日）');
    var msg = assignments.length + '件の清掃を割り当てました。\n' +
              '割り当て結果シートを確認してください。';
    if (defr > 0) msg += '\n\n📅 翌日清掃に延期: ' + defr + '件';
    if (ext > 0)  msg += '\n⚠ Rクリーンへの外注: ' + ext + '件';
    if (una > 0)  msg += '\n⚠ 未割当（要確認）: ' + una + '件';
    showAlert_('割り当て完了', msg);
  } catch (e) {
    showAlert_('エラー', e.message);
  }
}

function syncToCalendarMenu() {
  try {
    var result = doSyncToCalendar_();
    showAlert_('カレンダー反映完了',
      '新規作成: ' + result.created + '件\n' +
      '削除: ' + result.deleted + '件\n\n' +
      '※ 変更のない予定はそのまま保持されています。'
    );
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
    var calResult = doSyncToCalendar_();

    var ext  = countByStatus_(assignments, '外注');
    var una  = countByStatus_(assignments, '要確認');
    var defr = countByStatus_(assignments, '確定（翌日）');
    var msg = '割り当て: ' + assignments.length + '件\n' +
              'カレンダー新規作成: ' + calResult.created + '件\n' +
              'カレンダー削除: ' + calResult.deleted + '件';
    if (defr > 0) msg += '\n\n📅 翌日清掃に延期: ' + defr + '件（外注回避）';
    if (ext > 0)  msg += '\n⚠ Rクリーンへの外注が ' + ext + '件あります';
    if (una > 0)  msg += '\n⚠ 未割当（要確認）が ' + una + '件あります';
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

function parseDateStr_(dateStr) {
  var parts = dateStr.split('/');
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
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
