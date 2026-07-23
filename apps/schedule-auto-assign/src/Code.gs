/**
 * 民泊清掃予定 自動割り当てシステム v5
 *
 * v4からの変更点:
 *   - 入力データに開始日・ゲスト数を追加（6列: 予約ID, タイトル, 開始日, チェックアウト日, ユニット, ゲスト）
 *   - 翌日清掃判定をタイトルベースから実データベースに変更
 *     （次の予約の開始日までに清掃できればよい）
 *   - 割り当て優先順位を単純化: 細田さん → 普久原さん → 未割当 → Rクリーン(14日以内)
 */

// ============================================================
// 定数
// ============================================================
var SHEET_RESERVATIONS = '予約データ';
var SHEET_RESULTS      = '割り当て結果';
var SHEET_SETTINGS     = '設定';
var SHEET_DB           = '同期データベース';
var SHEET_TIMELINE     = 'タイムライン';
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
  res.getRange('A1:F1')
    .setValues([['予約ID', 'タイトル', '開始日', 'チェックアウト日', 'ユニット', 'ゲスト']])
    .setFontWeight('bold').setBackground('#F0EBE3');
  res.getRange('A2').setValue('← Beds24 の Excel データをここに貼り付け（A1から上書きでもOK）')
    .setFontColor('#999999');
  res.setColumnWidth(1, 120);
  res.setColumnWidth(2, 200);
  res.setColumnWidth(3, 150);
  res.setColumnWidth(4, 150);
  res.setColumnWidth(5, 100);
  res.setColumnWidth(6, 80);

  // ----- 割り当て結果シート -----
  var out = getOrCreateSheet_(ss, SHEET_RESULTS);
  out.clear();
  out.getRange('A1:G1')
    .setValues([['予約ID', '日付', '曜日', 'ユニット', 'タイトル', '担当', 'ステータス']])
    .setFontWeight('bold').setBackground('#F0EBE3');

  // ----- 同期データベースシート -----
  var db = getOrCreateSheet_(ss, SHEET_DB);
  db.clear();
  db.getRange('A1:I1')
    .setValues([['予約ID', 'チェックアウト日', '清掃日', 'ユニット', 'タイトル', '担当', 'イベントID', '同期状態', '最終同期']])
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
  db.setColumnWidth(8, 80);
  db.setColumnWidth(9, 150);

  // ----- タイムラインシート -----
  var tl = getOrCreateSheet_(ss, SHEET_TIMELINE);
  tl.clear();
  tl.getRange('A1').setValue('※ 割り当て実行後にタイムラインが自動生成されます。')
    .setFontColor('#999999');
  tl.setTabColor('#4A90D9');

  removeDefaultSheet_(ss);

  SpreadsheetApp.getUi().alert(
    '初期設定が完了しました',
    '次の手順で進めてください:\n\n' +
    '1. 「設定」シートにカレンダーIDを入力\n' +
    '2. スタッフに入力ルールを案内\n' +
    '   → カレンダーに終日イベントで「名前+件数」を入力\n' +
    '   （例: 細田③ / 普久原3 / 0 = 出勤不可）\n' +
    '3. 「予約データ」シートにExcelデータを貼り付け\n' +
    '   （形式: 予約ID, タイトル, 開始日, チェックアウト日, ユニット, ゲスト）\n' +
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

  var cols = Math.min(sheet.getLastColumn(), 6);
  var data = sheet.getRange(1, 1, lastRow, cols).getValues();
  var results = [];
  var seen = {};

  for (var i = 0; i < data.length; i++) {
    var bookingId  = String(data[i][0]).trim();
    var title      = String(data[i][1]).trim();
    var rawStart   = data[i][2];
    var rawCheckout = data[i][3];
    var unit       = String(data[i][4]).trim();
    var guests     = (cols >= 6 && data[i][5] !== '') ? Number(data[i][5]) || 0 : 0;

    if (!bookingId || !unit) continue;
    if (bookingId === '予約ID') continue;
    if (String(rawCheckout).indexOf('チェックアウト') >= 0) continue;
    if (!/^\d+$/.test(bookingId)) continue;

    var startDate = toDate_(rawStart);
    var checkoutDate = toDate_(rawCheckout);
    if (!checkoutDate) continue;

    if (seen[bookingId]) continue;
    seen[bookingId] = true;

    results.push({
      bookingId:    bookingId,
      title:        title || '',
      startDate:    startDate,
      startDateStr: startDate ? formatDate_(startDate) : '',
      date:         checkoutDate,
      dateStr:      formatDate_(checkoutDate),
      unit:         unit,
      dow:          checkoutDate.getDay(),
      guests:       guests
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

  var cols = Math.min(sheet.getLastColumn(), 9);
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols).getValues();
  var db = {};

  for (var i = 0; i < data.length; i++) {
    var bid = String(data[i][0]).trim();
    if (!bid || !/^\d+$/.test(bid)) continue;

    if (cols >= 9) {
      db[bid] = {
        bookingId:       bid,
        checkoutDateStr: normalizeDateStr_(data[i][1]),
        cleaningDateStr: normalizeDateStr_(data[i][2]),
        unit:            String(data[i][3]).trim(),
        title:           String(data[i][4]).trim(),
        staff:           String(data[i][5]).trim(),
        eventId:         String(data[i][6]).trim(),
        syncStatus:      String(data[i][7]).trim(),
        lastSync:        data[i][8]
      };
    } else if (cols >= 8) {
      var eid8 = String(data[i][6]).trim();
      db[bid] = {
        bookingId:       bid,
        checkoutDateStr: normalizeDateStr_(data[i][1]),
        cleaningDateStr: normalizeDateStr_(data[i][2]),
        unit:            String(data[i][3]).trim(),
        title:           String(data[i][4]).trim(),
        staff:           String(data[i][5]).trim(),
        eventId:         eid8,
        syncStatus:      eid8 ? '完了' : '未同期',
        lastSync:        data[i][7]
      };
    } else {
      var dateVal = normalizeDateStr_(data[i][1]);
      var eid7 = String(data[i][5]).trim();
      db[bid] = {
        bookingId:       bid,
        checkoutDateStr: dateVal,
        cleaningDateStr: dateVal,
        unit:            String(data[i][2]).trim(),
        title:           String(data[i][3]).trim(),
        staff:           String(data[i][4]).trim(),
        eventId:         eid7,
        syncStatus:      eid7 ? '完了' : '未同期',
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
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).clearContent();
  }
  sheet.getRange('A1:I1')
    .setValues([['予約ID', 'チェックアウト日', '清掃日', 'ユニット', 'タイトル', '担当', 'イベントID', '同期状態', '最終同期']])
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
      r.syncStatus || '未同期',
      r.lastSync || now
    ]);
  }

  sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
  sheet.getRange(2, 2, rows.length, 2).setNumberFormat('@');
  sheet.getRange(2, 1, rows.length, 9).setValues(rows);
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

  var ci = {'⓪':0,'①':1,'②':2,'③':3,'④':4,'⑤':5,'⑥':6,'⑦':7,'⑧':8,'⑨':9};
  var fw = {'０':0,'１':1,'２':2,'３':3,'４':4,'５':5,'６':6,'７':7,'８':8,'９':9};

  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    if (c >= '0' && c <= '9') return parseInt(c);
    if (ci[c] !== undefined) return ci[c];
    if (fw[c] !== undefined) return fw[c];
  }

  return null;
}

function getCapForDate_(staffCaps, staffInfo, dateStr) {
  var caps = staffCaps[staffInfo.name];
  if (caps && caps[dateStr] !== undefined) return caps[dateStr];
  return staffInfo.defaultCap;
}

// ============================================================
// 清掃期限の算出
//
// 同じユニットの次の予約の開始日を見て、清掃がいつまでに
// 完了すればよいかを計算する。
// 清掃期限 = 次の予約の開始日 - 1（次の予約がなければチェックアウト日）
// ============================================================
function buildCleaningDeadlines_(reservations) {
  var byUnit = {};
  for (var i = 0; i < reservations.length; i++) {
    var r = reservations[i];
    if (!byUnit[r.unit]) byUnit[r.unit] = [];
    byUnit[r.unit].push(r);
  }

  var deadlines = {};
  var units = Object.keys(byUnit);
  for (var u = 0; u < units.length; u++) {
    var bookings = byUnit[units[u]];
    bookings.sort(function(a, b) { return a.date - b.date; });

    for (var b = 0; b < bookings.length; b++) {
      var bk = bookings[b];
      var deadline = bk.date;

      // 次の予約の開始日を探す（同ユニット内で最も早い開始日 >= チェックアウト日）
      var earliestNext = null;
      for (var n = 0; n < bookings.length; n++) {
        if (n === b || !bookings[n].startDate) continue;
        if (bookings[n].startDate >= bk.date) {
          if (!earliestNext || bookings[n].startDate < earliestNext) {
            earliestNext = bookings[n].startDate;
          }
        }
      }
      if (earliestNext) {
        var dayBefore = new Date(earliestNext);
        dayBefore.setDate(dayBefore.getDate() - 1);
        deadline = dayBefore;
      }

      // 害虫防止: 清掃期限はチェックアウト+2日が上限
      var maxDefer = new Date(bk.date);
      maxDefer.setDate(maxDefer.getDate() + 2);
      if (deadline > maxDefer) deadline = maxDefer;

      // 期限がチェックアウト日より前になる場合はチェックアウト日当日が期限
      if (deadline < bk.date) deadline = bk.date;

      deadlines[bk.bookingId] = {
        deadline:    deadline,
        deadlineStr: formatDate_(deadline),
        canDefer:    deadline > bk.date
      };
    }
  }
  return deadlines;
}

// ============================================================
// マッチングアルゴリズム（v5）
//
// Phase 1: 通常の割り当て（延期不可を優先してスタッフに割り当て）
//   細田さん → 普久原さん → 未割当
// Phase 2: 清掃延期処理（未割当を+1/+2日でスタッフに振り替え）
// Phase 2.5: Rクリーン回避（同日スタッフの延期可能予約と未割当を入れ替え）
// Phase 3: Rクリーン安全ネット（14日以内の未割当→Rクリーン）
// Phase 4: Rクリーンコスト最適化（ゲスト数が少ない部屋にRクリーンを入れ替え）
// ============================================================
function doMatching_() {
  var cfg = getSettings_();
  var reservations = readReservations_();
  if (reservations.length === 0) return [];

  var deadlines = buildCleaningDeadlines_(reservations);
  var db   = readDatabase_();
  var diff = computeDiff_(reservations, db);

  // Rクリーン割り当ての期限: 実行日から14日以内の未割当はRクリーンに
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var rclDeadline = new Date(today);
  rclDeadline.setDate(rclDeadline.getDate() + 14);

  // スタッフ情報を特定（細田さん=第1優先、普久原さん=第2優先）
  var hosodaInfo = null, fukuharaInfo = null, rclInfo = null;
  for (var si = 0; si < cfg.staff.length; si++) {
    if (cfg.staff[si].name === '細田さん')        hosodaInfo = cfg.staff[si];
    else if (cfg.staff[si].name === '普久原さん') fukuharaInfo = cfg.staff[si];
    else if (cfg.staff[si].name === 'Rクリーン')  rclInfo = cfg.staff[si];
  }
  if (!hosodaInfo || !fukuharaInfo) {
    throw new Error('設定シートに「細田さん」と「普久原さん」が必要です。');
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
                       (cds !== uc.newData.dateStr ? '確定（翌日）' : '確定')),
      guests:          uc.newData.guests || 0
    };
    // 14日以上先のRクリーン → 未割当に戻す（まだスタッフ確定の余地あり）
    if (a.staff === 'Rクリーン' && cleaningDate >= rclDeadline) {
      a.staff = '未割当';
      a.status = '要確認';
    }

    // 翌日送りだった予約の清掃期限を再チェック（新規予約で期限が縮まる場合）
    var dl = deadlines[a.bookingId];
    if (dl && a.status === '確定（翌日）' && cleaningDate > dl.deadline) {
      a.date    = uc.newData.date;
      a.dateStr = uc.newData.dateStr;
      a.dayName = DAY_NAMES[uc.newData.dow];
      a.staff   = '未割当';
      a.status  = '要確認';
    }

    allAssignments.push(a);

    if (!usageByDate[cds]) usageByDate[cds] = {};
    usageByDate[cds][a.staff] = (usageByDate[cds][a.staff] || 0) + 1;
  }

  // --- 新規＋変更分を割り当て ---
  var toAssign = [];
  for (var ad = 0; ad < diff.added.length; ad++)   toAssign.push(diff.added[ad]);
  for (var ch = 0; ch < diff.changed.length; ch++) toAssign.push(diff.changed[ch].newData);

  // 必要な日付を収集（全割り当て＋新規の +1日・+2日も取得）
  var datesNeeded = {};
  for (var ai = 0; ai < allAssignments.length; ai++) {
    datesNeeded[allAssignments[ai].dateStr] = true;
    var ad1 = new Date(allAssignments[ai].date);
    ad1.setDate(ad1.getDate() + 1);
    datesNeeded[formatDate_(ad1)] = true;
    var ad2 = new Date(allAssignments[ai].date);
    ad2.setDate(ad2.getDate() + 2);
    datesNeeded[formatDate_(ad2)] = true;
  }
  for (var t = 0; t < toAssign.length; t++) {
    datesNeeded[toAssign[t].dateStr] = true;
    var nd1 = new Date(toAssign[t].date);
    nd1.setDate(nd1.getDate() + 1);
    datesNeeded[formatDate_(nd1)] = true;
    var nd2 = new Date(toAssign[t].date);
    nd2.setDate(nd2.getDate() + 2);
    datesNeeded[formatDate_(nd2)] = true;
  }

  var staffCaps = {};
  var datesToCheck = Object.keys(datesNeeded);
  if (datesToCheck.length > 0) {
    for (var s = 0; s < cfg.staff.length; s++) {
      staffCaps[cfg.staff[s].name] =
        getCapacityForDates_(cfg.staff[s].calendarId, datesToCheck);
    }
  }

  if (toAssign.length > 0) {
    // Phase 1: 日付ごとの割り当て
    //   延期不可の予約を先にスタッフに割り当て（延期可能な予約が溢れるように）
    //   優先順位: 細田さん → 普久原さん → 未割当
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
      var newItems = info.items;

      // 延期不可の予約を先頭に並べ替え（スタッフ枠を優先的に確保）
      newItems.sort(function(a, b) {
        var aDef = deadlines[a.bookingId] && deadlines[a.bookingId].canDefer ? 1 : 0;
        var bDef = deadlines[b.bookingId] && deadlines[b.bookingId].canDefer ? 1 : 0;
        return aDef - bDef;
      });

      var total    = newItems.length;

      var hosodaCap   = getCapForDate_(staffCaps, hosodaInfo, dk);
      var fukuharaCap = getCapForDate_(staffCaps, fukuharaInfo, dk);

      var eu            = usageByDate[dk] || {};
      var existHosoda   = eu[hosodaInfo.name] || 0;
      var existFukuhara = eu[fukuharaInfo.name] || 0;

      var hosodaRemain   = Math.max(0, hosodaCap - existHosoda);
      var fukuharaRemain = Math.max(0, fukuharaCap - existFukuhara);

      // 1. 細田さんの枠いっぱいまで
      var hosodaAlloc = Math.min(total, hosodaRemain);
      // 2. 残りを普久原さん
      var fukuharaAlloc = Math.min(total - hosodaAlloc, fukuharaRemain);
      // 3. さらに残りは未割当（Phase 3でRクリーン判定）
      var remaining = total - hosodaAlloc - fukuharaAlloc;

      var unitIdx = 0;
      for (var a1 = 0; a1 < hosodaAlloc; a1++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], hosodaInfo.name));
        addUsage_(usageByDate, dk, hosodaInfo.name);
      }
      for (var a2 = 0; a2 < fukuharaAlloc; a2++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], fukuharaInfo.name));
        addUsage_(usageByDate, dk, fukuharaInfo.name);
      }
      for (var a3 = 0; a3 < remaining; a3++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], '未割当'));
        addUsage_(usageByDate, dk, '未割当');
      }
    }
  }

  // --------------------------------------------------------
  // Phase 2: 清掃延期処理
  //
  // 未割当に回った予約で、+1日 or +2日にスタッフ枠がある場合
  // そちらに振り替える。早い日を優先。
  // 優先順位: 細田さん → 普久原さん
  // --------------------------------------------------------
  var deferCount = 0;
  for (var df = 0; df < allAssignments.length; df++) {
    var asgn = allAssignments[df];
    if (asgn.staff !== '未割当') continue;
    if (asgn.checkoutDateStr !== asgn.dateStr) continue;

    var dl = deadlines[asgn.bookingId];
    if (!dl || !dl.canDefer) continue;

    var deferTo = null;
    var deferDate = null;

    for (var offset = 1; offset <= 2 && !deferTo; offset++) {
      var tryDate = new Date(asgn.date);
      tryDate.setDate(tryDate.getDate() + offset);
      if (tryDate > dl.deadline) continue;

      var tryDateStr = formatDate_(tryDate);
      var hosodaCapTry   = getCapForDate_(staffCaps, hosodaInfo, tryDateStr);
      var fukuharaCapTry = getCapForDate_(staffCaps, fukuharaInfo, tryDateStr);
      var euTry          = usageByDate[tryDateStr] || {};
      var hosodaRemainT   = Math.max(0, hosodaCapTry - (euTry[hosodaInfo.name] || 0));
      var fukuharaRemainT = Math.max(0, fukuharaCapTry - (euTry[fukuharaInfo.name] || 0));

      if (hosodaRemainT > 0)        { deferTo = hosodaInfo.name; deferDate = tryDate; }
      else if (fukuharaRemainT > 0) { deferTo = fukuharaInfo.name; deferDate = tryDate; }
    }

    if (deferTo) {
      var origDate = asgn.dateStr;
      var origStaff = asgn.staff;
      var deferDateStr = formatDate_(deferDate);

      asgn.date    = deferDate;
      asgn.dateStr = deferDateStr;
      asgn.dayName = DAY_NAMES[deferDate.getDay()];
      asgn.staff   = deferTo;
      asgn.status  = '確定（翌日）';

      addUsage_(usageByDate, deferDateStr, deferTo);
      if (usageByDate[origDate] && usageByDate[origDate][origStaff]) {
        usageByDate[origDate][origStaff]--;
      }
      deferCount++;
    }
  }

  // --------------------------------------------------------
  // Phase 2.5: Rクリーン回避スワップ
  //
  // Phase 2で延期できなかった未割当予約について、同日のスタッフ割り当ての中に
  // 延期可能な予約があれば入れ替える。スタッフ予約を+1/+2日に移動し、
  // 空いた枠に未割当予約を入れることでRクリーンを回避する。
  // --------------------------------------------------------
  for (var sw = 0; sw < allAssignments.length; sw++) {
    var swAsgn = allAssignments[sw];
    if (swAsgn.staff !== '未割当') continue;

    var swapped = false;
    for (var cand = 0; cand < allAssignments.length && !swapped; cand++) {
      var candAsgn = allAssignments[cand];
      if (candAsgn.dateStr !== swAsgn.dateStr) continue;
      if (candAsgn.staff === '未割当' || candAsgn.staff === 'Rクリーン') continue;

      var candDl = deadlines[candAsgn.bookingId];
      if (!candDl || !candDl.canDefer) continue;
      if (candAsgn.checkoutDateStr !== candAsgn.dateStr) continue;

      for (var off2 = 1; off2 <= 2 && !swapped; off2++) {
        var moveDate = new Date(candAsgn.date);
        moveDate.setDate(moveDate.getDate() + off2);
        if (moveDate > candDl.deadline) continue;

        var moveDateStr = formatDate_(moveDate);
        var moveCap = getCapForDate_(staffCaps, { name: candAsgn.staff, defaultCap: 0 }, moveDateStr);
        var moveEu  = usageByDate[moveDateStr] || {};
        var moveRemain = Math.max(0, moveCap - (moveEu[candAsgn.staff] || 0));

        if (moveRemain > 0) {
          var freedStaff = candAsgn.staff;
          var origDay    = candAsgn.dateStr;

          candAsgn.date    = moveDate;
          candAsgn.dateStr = moveDateStr;
          candAsgn.dayName = DAY_NAMES[moveDate.getDay()];
          candAsgn.status  = '確定（翌日）';
          addUsage_(usageByDate, moveDateStr, freedStaff);
          if (usageByDate[origDay] && usageByDate[origDay][freedStaff]) {
            usageByDate[origDay][freedStaff]--;
          }

          swAsgn.staff  = freedStaff;
          swAsgn.status = '確定';
          addUsage_(usageByDate, swAsgn.dateStr, freedStaff);
          if (usageByDate[swAsgn.dateStr] && usageByDate[swAsgn.dateStr]['未割当']) {
            usageByDate[swAsgn.dateStr]['未割当']--;
          }
          deferCount++;
          swapped = true;
        }
      }
    }
  }

  // --------------------------------------------------------
  // Phase 3: Rクリーン安全ネット
  //
  // 14日以内の未割当をRクリーンに割り当て。
  // チェックアウト日当日を清掃日とする（早いほうが良い）。
  // --------------------------------------------------------
  for (var rn = 0; rn < allAssignments.length; rn++) {
    var ra = allAssignments[rn];
    if (ra.staff !== '未割当') continue;
    if (ra.date >= rclDeadline) continue;

    ra.staff  = 'Rクリーン';
    ra.status = '外注';
  }

  // --------------------------------------------------------
  // Phase 4: Rクリーンコスト最適化
  //
  // Rクリーンは宿泊人数が少ない部屋のほうが安い。
  // 同じ清掃日にRクリーンとスタッフの割り当てがある場合、
  // スタッフ担当の中にゲスト数がより少ない部屋があれば入れ替える。
  // --------------------------------------------------------
  var rclByDate = {};
  for (var ri = 0; ri < allAssignments.length; ri++) {
    if (allAssignments[ri].staff === 'Rクリーン') {
      if (!rclByDate[allAssignments[ri].dateStr]) rclByDate[allAssignments[ri].dateStr] = [];
      rclByDate[allAssignments[ri].dateStr].push(ri);
    }
  }
  var rclDates = Object.keys(rclByDate);
  for (var rd = 0; rd < rclDates.length; rd++) {
    var rclIdxs = rclByDate[rclDates[rd]];
    var staffIdxs = [];
    for (var si2 = 0; si2 < allAssignments.length; si2++) {
      var sa = allAssignments[si2];
      if (sa.dateStr === rclDates[rd] && sa.staff !== 'Rクリーン' && sa.staff !== '未割当') {
        staffIdxs.push(si2);
      }
    }
    if (staffIdxs.length === 0) continue;

    for (var rx = 0; rx < rclIdxs.length; rx++) {
      var rIdx = rclIdxs[rx];
      var rAsgn = allAssignments[rIdx];
      var bestSwap = -1;
      var bestGuests = rAsgn.guests;

      for (var sx = 0; sx < staffIdxs.length; sx++) {
        var sIdx = staffIdxs[sx];
        var sAsgn = allAssignments[sIdx];
        if (sAsgn.guests < bestGuests) {
          bestGuests = sAsgn.guests;
          bestSwap = sx;
        }
      }

      if (bestSwap >= 0) {
        var swapIdx = staffIdxs[bestSwap];
        var swapAsgn = allAssignments[swapIdx];

        var tmpStaff  = rAsgn.staff;
        var tmpStatus = rAsgn.status;
        rAsgn.staff      = swapAsgn.staff;
        rAsgn.status     = swapAsgn.status;
        swapAsgn.staff   = tmpStaff;
        swapAsgn.status  = tmpStatus;

        staffIdxs.splice(bestSwap, 1);
        staffIdxs.push(rIdx);
        rclIdxs[rx] = swapIdx;
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
    status:          statusFor_(staffName),
    guests:          booking.guests || 0
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
  sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
  sheet.getRange(2, 2, rows.length, 1).setNumberFormat('@');
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

    var cleaningDateStr = normalizeDateStr_(resultData[i][1]);
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

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var toDelete = [];
  var toCreate = [];
  var toCancel = [];
  var newDb    = {};

  // DB既存分を確認（清掃日・担当等で比較）
  var dbKeys = Object.keys(db);
  for (var d = 0; d < dbKeys.length; d++) {
    var dbBid  = dbKeys[d];
    var dbRec  = db[dbBid];
    var curRec = current[dbBid];

    if (dbRec.syncStatus === '手動') {
      newDb[dbBid] = dbRec;
      continue;
    }

    if (!curRec) {
      var cleanDate = parseDateStr_(dbRec.cleaningDateStr);
      if (cleanDate >= today && dbRec.eventId && dbRec.syncStatus === '完了') {
        toCancel.push(dbRec);
      }
      // 過去の予約は自然消滅、DBから除外するだけ（カレンダーは触らない）
    } else if (dbRec.cleaningDateStr !== curRec.cleaningDateStr ||
               dbRec.unit !== curRec.unit || dbRec.title !== curRec.title ||
               dbRec.staff !== curRec.staff) {
      if (dbRec.eventId) toDelete.push(dbRec);
      toCreate.push(curRec);
      newDb[dbBid] = {
        bookingId: dbBid, checkoutDateStr: curRec.checkoutDateStr,
        cleaningDateStr: curRec.cleaningDateStr, unit: curRec.unit,
        title: curRec.title, staff: curRec.staff,
        eventId: '', syncStatus: '未同期', lastSync: ''
      };
    } else if (dbRec.syncStatus === '未同期') {
      toCreate.push(curRec);
      newDb[dbBid] = dbRec;
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
        title: current[curBid].title, staff: current[curBid].staff,
        eventId: '', syncStatus: '未同期', lastSync: ''
      };
    }
  }

  // イベント削除（レート制限対策: 5件ごとに1秒待機）
  // 手動編集検知: カレンダーのタイトルがシステム生成と異なる場合はスキップ
  var deleted = 0;
  var manualCount = 0;
  var errors = [];
  for (var del = 0; del < toDelete.length; del++) {
    if (del > 0 && del % 5 === 0) Utilities.sleep(1000);
    try {
      var ev = cal.getEventById(toDelete[del].eventId);
      if (ev) {
        var expectedTitle = buildEventTitle_(toDelete[del].staff, toDelete[del].unit, toDelete[del].title);
        var actualTitle = ev.getTitle().trim();
        if (actualTitle !== expectedTitle) {
          newDb[toDelete[del].bookingId] = toDelete[del];
          newDb[toDelete[del].bookingId].syncStatus = '手動';
          var createIdx = -1;
          for (var fi = 0; fi < toCreate.length; fi++) {
            if (toCreate[fi].bookingId === toDelete[del].bookingId) { createIdx = fi; break; }
          }
          if (createIdx >= 0) toCreate.splice(createIdx, 1);
          manualCount++;
          continue;
        }
        ev.deleteEvent(); deleted++;
      }
    } catch (err) {
      errors.push('削除失敗(ID:' + toDelete[del].bookingId + '): ' + err.message);
    }
  }

  // キャンセル検知: 予約データから消えた未来の予約のイベントタイトルを更新
  var cancelled = 0;
  for (var cn = 0; cn < toCancel.length; cn++) {
    if (cn > 0 && cn % 5 === 0) Utilities.sleep(1000);
    try {
      var cev = cal.getEventById(toCancel[cn].eventId);
      if (cev) {
        var cancelLabel = toCancel[cn].title
          ? toCancel[cn].unit + '(' + toCancel[cn].title + ')'
          : toCancel[cn].unit;
        cev.setTitle(cancelLabel + 'の予定はキャンセルされました');
        cev.setColor('11');
        cancelled++;
      }
    } catch (err) {
      errors.push('キャンセル更新失敗(ID:' + toCancel[cn].bookingId + '): ' + err.message);
    }
  }

  // イベント作成（レート制限対策: 5件ごとに1秒待機、失敗時リトライ）
  var created = 0;
  var skipped = 0;
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

  for (var cr = 0; cr < toCreate.length; cr++) {
    var rec = toCreate[cr];
    // 未割当もカレンダーに出力する

    if (created > 0 && created % 5 === 0) Utilities.sleep(1000);

    var evTitle = buildEventTitle_(rec.staff, rec.unit, rec.title);
    var evDate = parseDateStr_(rec.cleaningDateStr);

    if (isNaN(evDate.getTime())) {
      errors.push('日付変換失敗(ID:' + rec.bookingId + '): "' + rec.cleaningDateStr + '"');
      continue;
    }

    var success = false;
    for (var retry = 0; retry < 3 && !success; retry++) {
      try {
        if (retry > 0) Utilities.sleep(retry * 5000);
        var newEv = cal.createAllDayEvent(evTitle, evDate);
        newEv.setDescription(
          SYSTEM_TAG + '\n予約ID: ' + rec.bookingId + '\n' +
          '自動割当システムにより作成\n作成日時: ' + now
        );

        if (rec.staff === '細田さん')   newEv.setColor('1');
        if (rec.staff === '普久原さん') newEv.setColor('6');
        if (rec.staff === 'Rクリーン')  newEv.setColor('3');
        if (rec.staff === '未割当')     newEv.setColor('8');

        newDb[rec.bookingId].eventId    = newEv.getId();
        newDb[rec.bookingId].syncStatus = '完了';
        newDb[rec.bookingId].lastSync   = now;
        created++;
        success = true;
      } catch (err) {
        if (retry === 2) {
          newDb[rec.bookingId].syncStatus = '未同期';
          errors.push('作成失敗(ID:' + rec.bookingId + '): ' + err.message);
        }
      }
    }
  }

  writeDatabase_(newDb);

  var unsyncCount = 0;
  var dbk = Object.keys(newDb);
  for (var uk = 0; uk < dbk.length; uk++) {
    if (newDb[dbk[uk]].syncStatus === '未同期') unsyncCount++;
  }

  return { created: created, deleted: deleted, cancelled: cancelled, manual: manualCount, errors: errors, pending: toCreate.length, skipped: skipped, unsyncCount: unsyncCount };
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
    writeGanttChart_(assignments);

    var ext  = countByStatus_(assignments, '外注');
    var una  = countByStatus_(assignments, '要確認');
    var defr = countByStatus_(assignments, '確定（翌日）');
    var msg = assignments.length + '件の清掃を割り当てました。\n' +
              '割り当て結果シートを確認してください。';
    if (defr > 0) msg += '\n\n📅 清掃延期: ' + defr + '件';
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
    var msg = '新規作成: ' + result.created + '件\n' +
              '削除: ' + result.deleted + '件';
    if (result.cancelled > 0) msg += '\nキャンセル検知: ' + result.cancelled + '件';
    if (result.manual > 0) msg += '\n✋ 手動編集保持: ' + result.manual + '件（上書きスキップ）';
    msg += '\n\n※ 変更のない予定はそのまま保持されています。';
    if (result.unsyncCount > 0) {
      msg += '\n\n⏳ 未同期: ' + result.unsyncCount + '件（次回実行でリトライされます）';
    }
    if (result.errors && result.errors.length > 0) {
      msg += '\n\n❌ エラー ' + result.errors.length + '件:\n' + result.errors.slice(0, 5).join('\n');
    }
    showAlert_('カレンダー反映完了', msg);
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
    writeGanttChart_(assignments);
    var calResult = doSyncToCalendar_();

    var ext  = countByStatus_(assignments, '外注');
    var una  = countByStatus_(assignments, '要確認');
    var defr = countByStatus_(assignments, '確定（翌日）');
    var msg = '割り当て: ' + assignments.length + '件\n' +
              'カレンダー新規作成: ' + calResult.created + '件\n' +
              'カレンダー削除: ' + calResult.deleted + '件';
    if (calResult.cancelled > 0) msg += '\nキャンセル検知: ' + calResult.cancelled + '件';
    if (calResult.manual > 0) msg += '\n✋ 手動編集保持: ' + calResult.manual + '件（上書きスキップ）';
    if (defr > 0) msg += '\n\n📅 清掃延期: ' + defr + '件（外注回避）';
    if (ext > 0)  msg += '\n⚠ Rクリーンへの外注が ' + ext + '件あります';
    if (una > 0)  msg += '\n⚠ 未割当（要確認）が ' + una + '件あります';
    if (calResult.unsyncCount > 0) {
      msg += '\n\n⏳ 未同期: ' + calResult.unsyncCount + '件（「カレンダー反映のみ」で再実行してください）';
    }
    if (calResult.errors && calResult.errors.length > 0) {
      msg += '\n\n❌ カレンダーエラー ' + calResult.errors.length + '件:\n' + calResult.errors.slice(0, 5).join('\n');
    }
    showAlert_('一括実行完了', msg);
  } catch (e) {
    showAlert_('エラー', e.message);
  }
}

// ============================================================
// タイムラインシート出力（ユニット×日付のガントチャート）
//
// 1日＝3セル構成:
//   左セル: チェックアウト前（ゲストがまだいる状態）
//   中セル: 清掃（担当者の略称）
//   右セル: チェックイン後（新ゲストが到着した状態）
// ============================================================
function writeGanttChart_(assignments) {
  var reservations = readReservations_();
  if (reservations.length === 0) return;

  var deadlines = buildCleaningDeadlines_(reservations);

  // --- 日付範囲を決定 ---
  var minDate = null, maxDate = null;
  for (var i = 0; i < reservations.length; i++) {
    var r = reservations[i];
    var start = r.startDate || r.date;
    var dl = deadlines[r.bookingId] ? deadlines[r.bookingId].deadline : r.date;
    if (!minDate || start < minDate) minDate = start;
    if (!maxDate || dl > maxDate) maxDate = dl;
    if (!maxDate || r.date > maxDate) maxDate = r.date;
  }
  minDate = new Date(minDate); minDate.setDate(minDate.getDate() - 1);
  maxDate = new Date(maxDate); maxDate.setDate(maxDate.getDate() + 1);

  var dates = [];
  var d = new Date(minDate);
  while (d <= maxDate) {
    dates.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }

  var UNITS = ['b4','b5','b6','b2','b3','s1','s2','s3','c4'];

  // --- マップ構築 ---
  var assignMap = {};
  for (var a = 0; a < assignments.length; a++) {
    var asn = assignments[a];
    assignMap[asn.unit + '|' + asn.dateStr] = asn;
  }

  var stayMap = {};    // startDate〜checkout前日
  var coMap = {};      // checkout日
  var checkinMap = {}; // startDate（チェックイン日）
  var deadlineMap = {};

  for (var ri = 0; ri < reservations.length; ri++) {
    var res = reservations[ri];
    if (!res.startDate) continue;

    checkinMap[res.unit + '|' + formatDate_(res.startDate)] = res.bookingId;

    var stay = new Date(res.startDate);
    var coMinus1 = new Date(res.date);
    coMinus1.setDate(coMinus1.getDate() - 1);
    while (stay <= coMinus1) {
      stayMap[res.unit + '|' + formatDate_(stay)] = res.bookingId;
      stay.setDate(stay.getDate() + 1);
    }

    coMap[res.unit + '|' + formatDate_(res.date)] = res.bookingId;

    var dl = deadlines[res.bookingId];
    if (dl && dl.canDefer) {
      var wd = new Date(res.date);
      wd.setDate(wd.getDate() + 1);
      while (wd <= dl.deadline) {
        if (!assignMap[res.unit + '|' + formatDate_(wd)]) {
          deadlineMap[res.unit + '|' + formatDate_(wd)] = res.bookingId;
        }
        wd.setDate(wd.getDate() + 1);
      }
    }
  }

  // --- シート構築 ---
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SHEET_TIMELINE);
  sheet.clear();

  var numCols = dates.length * 3 + 1;

  // ヘッダ行1: 日付（3セル結合）
  var row1 = [''];
  for (var di = 0; di < dates.length; di++) {
    row1.push(Utilities.formatDate(dates[di], 'Asia/Tokyo', 'M/d'));
    row1.push('');
    row1.push('');
  }

  // ヘッダ行2: 曜日（3セル結合）
  var row2 = [''];
  for (var dj = 0; dj < dates.length; dj++) {
    row2.push(DAY_NAMES[dates[dj].getDay()]);
    row2.push('');
    row2.push('');
  }

  // データ行: 各ユニット
  var allRows = [row1, row2];
  for (var ui = 0; ui < UNITS.length; ui++) {
    var unit = UNITS[ui];
    var row = [unit];
    for (var dk = 0; dk < dates.length; dk++) {
      var dateStr = formatDate_(dates[dk]);
      var key = unit + '|' + dateStr;
      var isStay    = !!stayMap[key];
      var isCO      = !!coMap[key];
      var isCheckin = !!checkinMap[key];
      var asnObj    = assignMap[key];

      // 左セル: CO前（ゲストがまだいる）
      if (isCO) {
        row.push('CO');
      } else if (isStay && !isCheckin) {
        row.push('■');
      } else {
        row.push('');
      }

      // 中セル: 清掃
      if (asnObj) {
        row.push(staffAbbr_(asnObj.staff));
      } else if (deadlineMap[key]) {
        row.push('…');
      } else if (isStay && !isCheckin) {
        row.push('■');
      } else {
        row.push('');
      }

      // 右セル: CI後（ゲストが到着）
      if (isStay) {
        row.push('■');
      } else {
        row.push('');
      }
    }
    allRows.push(row);
  }

  // 凡例
  allRows.push([]);
  allRows.push(['【凡例】', 'CO = チェックアウト', '', '', '細/普 = スタッフ清掃', '', '', 'R = Rクリーン', '', '', '? = 未割当', '', '', '… = 清掃猶予', '', '', '■ = 滞在中']);

  sheet.getRange(1, 1, allRows.length, numCols).setValues(
    allRows.map(function(r) {
      while (r.length < numCols) r.push('');
      return r;
    })
  );

  // --- 書式設定 ---

  // ヘッダ結合
  for (var mi = 0; mi < dates.length; mi++) {
    var startCol = mi * 3 + 2;
    sheet.getRange(1, startCol, 1, 3).merge().setHorizontalAlignment('center');
    sheet.getRange(2, startCol, 1, 3).merge().setHorizontalAlignment('center');
  }

  sheet.getRange(1, 1, 1, numCols).setFontWeight('bold').setBackground('#E3E8F0');
  sheet.getRange(2, 1, 1, numCols).setFontWeight('bold').setBackground('#E3E8F0');
  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(1);

  sheet.setColumnWidth(1, 50);
  sheet.getRange(3, 1, UNITS.length, 1).setFontWeight('bold').setBackground('#F5F5F5');

  for (var cw = 2; cw <= numCols; cw++) {
    sheet.setColumnWidth(cw, 26);
  }

  // 土日ヘッダ色
  for (var dh = 0; dh < dates.length; dh++) {
    var dow = dates[dh].getDay();
    var hCol = dh * 3 + 2;
    if (dow === 0) {
      sheet.getRange(1, hCol, 2, 3).setBackground('#FCE4EC').setFontColor('#C62828');
    } else if (dow === 6) {
      sheet.getRange(1, hCol, 2, 3).setBackground('#E3F2FD').setFontColor('#1565C0');
    }
  }

  // 1日3セルをボックスで囲む罫線
  var borderColor = '#999999';
  var borderStyle = SpreadsheetApp.BorderStyle.SOLID;
  for (var bd = 0; bd < dates.length; bd++) {
    var bCol = bd * 3 + 2;
    // ヘッダ+データ行をまとめて囲む（上・左・下・右）
    sheet.getRange(1, bCol, UNITS.length + 2, 3)
      .setBorder(true, true, true, true, null, null, borderColor, borderStyle);
  }

  // セル色塗り
  var BG_STAY     = '#CFE2F3';
  var BG_CO       = '#FCE5CD';
  var BG_STAFF    = '#D9EAD3';
  var BG_RCLEAN   = '#E8D5F5';
  var BG_UNASSIGN = '#FBEAE6';
  var BG_WINDOW   = '#FFF2CC';

  for (var ru = 0; ru < UNITS.length; ru++) {
    for (var cd = 0; cd < dates.length; cd++) {
      var ds = formatDate_(dates[cd]);
      var ck = UNITS[ru] + '|' + ds;
      var rowIdx = ru + 3;
      var baseCol = cd * 3 + 2;

      var isS  = !!stayMap[ck];
      var isC  = !!coMap[ck];
      var isCI = !!checkinMap[ck];
      var aObj = assignMap[ck];

      // 左セル
      var mCell = sheet.getRange(rowIdx, baseCol);
      mCell.setHorizontalAlignment('center').setFontSize(8);
      if (isC) {
        mCell.setBackground(BG_CO);
      } else if (isS && !isCI) {
        mCell.setBackground(BG_STAY);
      }

      // 中セル
      var dCell = sheet.getRange(rowIdx, baseCol + 1);
      dCell.setHorizontalAlignment('center').setFontSize(8);
      if (aObj) {
        var staff = aObj.staff;
        if (staff === 'Rクリーン') {
          dCell.setBackground(BG_RCLEAN);
        } else if (staff === '未割当') {
          dCell.setBackground(BG_UNASSIGN);
        } else {
          dCell.setBackground(BG_STAFF);
        }
      } else if (deadlineMap[ck]) {
        dCell.setBackground(BG_WINDOW);
      } else if (isS && !isCI) {
        dCell.setBackground(BG_STAY);
      }

      // 右セル
      var eCell = sheet.getRange(rowIdx, baseCol + 2);
      eCell.setHorizontalAlignment('center').setFontSize(8);
      if (isS) {
        eCell.setBackground(BG_STAY);
      }
    }
  }

  // 凡例
  var legendRow = UNITS.length + 4;
  sheet.getRange(legendRow, 1).setFontWeight('bold');

  sheet.setTabColor('#4A90D9');
}

function staffAbbr_(name) {
  if (!name) return '?';
  if (name === 'Rクリーン') return 'R';
  if (name === '未割当') return '?';
  if (name.indexOf('細田') >= 0) return '細';
  if (name.indexOf('普久原') >= 0) return '普';
  return name.charAt(0);
}

// ============================================================
// ユーティリティ
// ============================================================
function buildEventTitle_(staff, unit, title) {
  return title ? staff + '⇒' + unit + '(' + title + ')' : staff + '⇒' + unit;
}

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
  var s = normalizeDateStr_(dateStr);
  var parts = s.split('/');
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

function formatDate_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd');
}

function normalizeDateStr_(val) {
  if (val instanceof Date) return formatDate_(val);
  var s = String(val).trim();
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) return s;
  var d = new Date(s);
  if (!isNaN(d.getTime())) return formatDate_(d);
  return s;
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
