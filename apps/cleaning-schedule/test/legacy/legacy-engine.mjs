/**
 * 比較用: 旧 GAS 版（v8）の割り当てロジック
 *
 * `apps/schedule-auto-assign/src/Code.gs` の以下をコピーしたもの。
 *   - DAY_NAMES / formatDate_ / parseDateStr_
 *   - getCapForDate_ (464-468行)
 *   - buildCleaningDeadlines_ (477-527行)
 *   - computeDiff_ (362-391行)
 *   - doMatching_ (540-946行)
 *   - makeAssignFromBooking_ / addUsage_ / statusFor_ (948-972行)
 *
 * 変更したのは以下のみ:
 *   1. スプレッドシート/カレンダーを読む4つの呼び出しを引数に差し替えた
 *      （getSettings_ → cfg / readReservations_ → reservations /
 *        readDatabase_ → db / getCapacityForDates_ → caps）
 *   2. `new Date()`（実行日）を引数 today に差し替えた
 *   3. GAS の Utilities.formatDate をローカル時刻ベースの実装に置き換えた
 *      （テストは TZ=UTC 固定で実行するため、GAS(JST) と同じ日付が得られる）
 *
 * ★ロジック本体には一切手を入れていない。整形もしない。
 *   新実装（src/core/assign.js）の出力がこれと一致することを parity.test.js で検証する。
 */

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

// GAS: Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd')
// テストは TZ=UTC で走らせ、Date もローカル（=UTC）で組み立てるため等価になる。
function formatDate_(d) {
  return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
}

function parseDateStr_(dateStr) {
  var parts = String(dateStr).split('/');
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

// ---- Code.gs:464-468 ----
function getCapForDate_(staffCaps, staffInfo, dateStr) {
  var caps = staffCaps[staffInfo.name];
  if (caps && caps[dateStr] !== undefined) return caps[dateStr];
  return staffInfo.defaultCap;
}

// ---- Code.gs:477-527 ----
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
    bookings.sort(function (a, b) { return a.date - b.date; });

    for (var b = 0; b < bookings.length; b++) {
      var bk = bookings[b];
      var deadline = bk.date;

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

      var maxDefer = new Date(bk.date);
      maxDefer.setDate(maxDefer.getDate() + 2);
      if (deadline > maxDefer) deadline = maxDefer;

      if (deadline < bk.date) deadline = bk.date;

      deadlines[bk.bookingId] = {
        deadline: deadline,
        deadlineStr: formatDate_(deadline),
        canDefer: deadline > bk.date
      };
    }
  }
  return deadlines;
}

// ---- Code.gs:362-391 ----
function computeDiff_(reservations, db) {
  var newIds = {};
  var added = [];
  var changed = [];
  var unchanged = [];

  for (var i = 0; i < reservations.length; i++) {
    var r = reservations[i];
    newIds[r.bookingId] = true;

    var prev = db[r.bookingId];
    if (!prev) {
      added.push(r);
    } else if (prev.checkoutDateStr !== r.dateStr || prev.unit !== r.unit) {
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

// ---- Code.gs:948-972 ----
function makeAssignFromBooking_(booking, staffName) {
  return {
    bookingId: booking.bookingId,
    checkoutDateStr: booking.dateStr,
    date: booking.date,
    dateStr: booking.dateStr,
    dayName: DAY_NAMES[booking.dow],
    unit: booking.unit,
    title: booking.title,
    staff: staffName,
    status: statusFor_(staffName),
    guests: booking.guests || 0
  };
}

function addUsage_(usageByDate, dateStr, staffName) {
  if (!usageByDate[dateStr]) usageByDate[dateStr] = {};
  usageByDate[dateStr][staffName] = (usageByDate[dateStr][staffName] || 0) + 1;
}

function statusFor_(staffName) {
  if (staffName === 'Rクリーン') return '外注';
  if (staffName === '未割当') return '要確認';
  return '確定';
}

// ---- Code.gs:540-946（I/O のみ引数化）----
export function legacyDoMatching({ cfg, reservations, db, caps, today }) {
  var deadlines = buildCleaningDeadlines_(reservations);
  var diff = computeDiff_(reservations, db);

  // Rクリーン割り当ての期限: 実行日から14日以内の未割当はRクリーンに
  var todayD = new Date(today);
  todayD.setHours(0, 0, 0, 0);
  var rclDeadline = new Date(todayD);
  rclDeadline.setDate(rclDeadline.getDate() + 14);

  var hosodaInfo = null, fukuharaInfo = null, fukudaInfo = null, rclInfo = null;
  for (var si = 0; si < cfg.staff.length; si++) {
    if (cfg.staff[si].name === '細田さん') hosodaInfo = cfg.staff[si];
    else if (cfg.staff[si].name === '普久原さん') fukuharaInfo = cfg.staff[si];
    else if (cfg.staff[si].name === '福田さん') fukudaInfo = cfg.staff[si];
    else if (cfg.staff[si].name === 'Rクリーン') rclInfo = cfg.staff[si];
  }
  if (!hosodaInfo || !fukuharaInfo || !fukudaInfo) {
    throw new Error('設定シートに「細田さん」「普久原さん」「福田さん」が必要です。');
  }

  var usageByDate = {};
  var allAssignments = [];

  // --- 既存割り当てを保持（清掃日ベース） ---
  for (var u = 0; u < diff.unchanged.length; u++) {
    var uc = diff.unchanged[u];
    var cds = uc.oldData.cleaningDateStr || uc.newData.dateStr;
    var cleaningDate = parseDateStr_(cds);
    var cleaningDow = cleaningDate.getDay();

    var a = {
      bookingId: uc.newData.bookingId,
      checkoutDateStr: uc.newData.dateStr,
      date: cleaningDate,
      dateStr: cds,
      dayName: DAY_NAMES[cleaningDow],
      unit: uc.newData.unit,
      title: uc.newData.title,
      staff: uc.oldData.staff,
      status: uc.oldData.staff === 'Rクリーン' ? '外注' :
        (uc.oldData.staff === '未割当' ? '要確認' :
          (cds !== uc.newData.dateStr ? '確定（翌日）' : '確定')),
      guests: uc.newData.guests || 0
    };
    if (a.staff === 'Rクリーン' && cleaningDate >= rclDeadline) {
      a.staff = '未割当';
      a.status = '要確認';
    }

    var dl = deadlines[a.bookingId];
    if (dl && a.status === '確定（翌日）' && cleaningDate > dl.deadline) {
      a.date = uc.newData.date;
      a.dateStr = uc.newData.dateStr;
      a.dayName = DAY_NAMES[uc.newData.dow];
      a.staff = '未割当';
      a.status = '要確認';
    }

    allAssignments.push(a);

    if (!usageByDate[cds]) usageByDate[cds] = {};
    usageByDate[cds][a.staff] = (usageByDate[cds][a.staff] || 0) + 1;
  }

  // --- 新規＋変更分を割り当て ---
  var toAssign = [];
  for (var ad = 0; ad < diff.added.length; ad++) toAssign.push(diff.added[ad]);
  for (var ch = 0; ch < diff.changed.length; ch++) toAssign.push(diff.changed[ch].newData);

  var staffCaps = caps;

  if (toAssign.length > 0) {
    var newByDate = {};
    for (var nb = 0; nb < toAssign.length; nb++) {
      var r = toAssign[nb];
      if (!newByDate[r.dateStr]) newByDate[r.dateStr] = { date: r.date, dow: r.dow, items: [] };
      newByDate[r.dateStr].items.push(r);
    }

    var dateKeys = Object.keys(newByDate).sort();
    for (var di = 0; di < dateKeys.length; di++) {
      var dk = dateKeys[di];
      var info = newByDate[dk];
      var newItems = info.items;

      newItems.sort(function (a, b) {
        var aDef = deadlines[a.bookingId] && deadlines[a.bookingId].canDefer ? 1 : 0;
        var bDef = deadlines[b.bookingId] && deadlines[b.bookingId].canDefer ? 1 : 0;
        return aDef - bDef;
      });

      var total = newItems.length;

      var hosodaCap = getCapForDate_(staffCaps, hosodaInfo, dk);
      var fukuharaCap = getCapForDate_(staffCaps, fukuharaInfo, dk);
      var fukudaCap = getCapForDate_(staffCaps, fukudaInfo, dk);

      var eu = usageByDate[dk] || {};
      var existHosoda = eu[hosodaInfo.name] || 0;
      var existFukuhara = eu[fukuharaInfo.name] || 0;
      var existFukuda = eu[fukudaInfo.name] || 0;

      var hosodaRemain = Math.max(0, hosodaCap - existHosoda);
      var fukuharaRemain = Math.max(0, fukuharaCap - existFukuhara);
      var fukudaRemain = Math.max(0, fukudaCap - existFukuda);

      var hosodaAlloc = Math.min(total, hosodaRemain);
      var fukuharaAlloc = Math.min(total - hosodaAlloc, fukuharaRemain);
      var fukudaAlloc = Math.min(total - hosodaAlloc - fukuharaAlloc, fukudaRemain);
      var remaining = total - hosodaAlloc - fukuharaAlloc - fukudaAlloc;

      var unitIdx = 0;
      for (var a1 = 0; a1 < hosodaAlloc; a1++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], hosodaInfo.name));
        addUsage_(usageByDate, dk, hosodaInfo.name);
      }
      for (var a2 = 0; a2 < fukuharaAlloc; a2++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], fukuharaInfo.name));
        addUsage_(usageByDate, dk, fukuharaInfo.name);
      }
      for (var a4 = 0; a4 < fukudaAlloc; a4++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], fukudaInfo.name));
        addUsage_(usageByDate, dk, fukudaInfo.name);
      }
      for (var a3 = 0; a3 < remaining; a3++, unitIdx++) {
        allAssignments.push(makeAssignFromBooking_(newItems[unitIdx], '未割当'));
        addUsage_(usageByDate, dk, '未割当');
      }
    }
  }

  // --- Phase 1.5 ---
  for (var ra2 = 0; ra2 < allAssignments.length; ra2++) {
    var raAsgn = allAssignments[ra2];
    if (raAsgn.staff !== '未割当') continue;

    var raDk = raAsgn.dateStr;
    var raHosodaCap = getCapForDate_(staffCaps, hosodaInfo, raDk);
    var raFukuharaCap = getCapForDate_(staffCaps, fukuharaInfo, raDk);
    var raFukudaCap = getCapForDate_(staffCaps, fukudaInfo, raDk);

    var raEu = usageByDate[raDk] || {};
    var raHosodaRemain = Math.max(0, raHosodaCap - (raEu[hosodaInfo.name] || 0));
    var raFukuharaRemain = Math.max(0, raFukuharaCap - (raEu[fukuharaInfo.name] || 0));
    var raFukudaRemain = Math.max(0, raFukudaCap - (raEu[fukudaInfo.name] || 0));

    var raNewStaff = null;
    if (raHosodaRemain > 0) raNewStaff = hosodaInfo.name;
    else if (raFukuharaRemain > 0) raNewStaff = fukuharaInfo.name;
    else if (raFukudaRemain > 0) raNewStaff = fukudaInfo.name;

    if (raNewStaff) {
      raAsgn.staff = raNewStaff;
      raAsgn.status = raAsgn.checkoutDateStr !== raAsgn.dateStr ? '確定（翌日）' : '確定';
      addUsage_(usageByDate, raDk, raNewStaff);
      if (raEu['未割当']) raEu['未割当']--;
    }
  }

  // --- Phase 2 ---
  var deferCount = 0;
  for (var df = 0; df < allAssignments.length; df++) {
    var asgn = allAssignments[df];
    if (asgn.staff !== '未割当') continue;
    if (asgn.checkoutDateStr !== asgn.dateStr) continue;

    var dl2 = deadlines[asgn.bookingId];
    if (!dl2 || !dl2.canDefer) continue;

    var deferTo = null;
    var deferDate = null;

    for (var offset = 1; offset <= 2 && !deferTo; offset++) {
      var tryDate = new Date(asgn.date);
      tryDate.setDate(tryDate.getDate() + offset);
      if (tryDate > dl2.deadline) continue;

      var tryDateStr = formatDate_(tryDate);
      var hosodaCapTry = getCapForDate_(staffCaps, hosodaInfo, tryDateStr);
      var fukuharaCapTry = getCapForDate_(staffCaps, fukuharaInfo, tryDateStr);
      var fukudaCapTry = getCapForDate_(staffCaps, fukudaInfo, tryDateStr);
      var euTry = usageByDate[tryDateStr] || {};
      var hosodaRemainT = Math.max(0, hosodaCapTry - (euTry[hosodaInfo.name] || 0));
      var fukuharaRemainT = Math.max(0, fukuharaCapTry - (euTry[fukuharaInfo.name] || 0));
      var fukudaRemainT = Math.max(0, fukudaCapTry - (euTry[fukudaInfo.name] || 0));

      if (hosodaRemainT > 0) { deferTo = hosodaInfo.name; deferDate = tryDate; }
      else if (fukuharaRemainT > 0) { deferTo = fukuharaInfo.name; deferDate = tryDate; }
      else if (fukudaRemainT > 0) { deferTo = fukudaInfo.name; deferDate = tryDate; }
    }

    if (deferTo) {
      var origDate = asgn.dateStr;
      var origStaff = asgn.staff;
      var deferDateStr = formatDate_(deferDate);

      asgn.date = deferDate;
      asgn.dateStr = deferDateStr;
      asgn.dayName = DAY_NAMES[deferDate.getDay()];
      asgn.staff = deferTo;
      asgn.status = '確定（翌日）';

      addUsage_(usageByDate, deferDateStr, deferTo);
      if (usageByDate[origDate] && usageByDate[origDate][origStaff]) {
        usageByDate[origDate][origStaff]--;
      }
      deferCount++;
    }
  }

  // --- Phase 2.5 ---
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
        var moveEu = usageByDate[moveDateStr] || {};
        var moveRemain = Math.max(0, moveCap - (moveEu[candAsgn.staff] || 0));

        if (moveRemain > 0) {
          var freedStaff = candAsgn.staff;
          var origDay = candAsgn.dateStr;

          candAsgn.date = moveDate;
          candAsgn.dateStr = moveDateStr;
          candAsgn.dayName = DAY_NAMES[moveDate.getDay()];
          candAsgn.status = '確定（翌日）';
          addUsage_(usageByDate, moveDateStr, freedStaff);
          if (usageByDate[origDay] && usageByDate[origDay][freedStaff]) {
            usageByDate[origDay][freedStaff]--;
          }

          swAsgn.staff = freedStaff;
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

  // --- Phase 3 ---
  for (var rn = 0; rn < allAssignments.length; rn++) {
    var ra = allAssignments[rn];
    if (ra.staff !== '未割当') continue;
    if (ra.date >= rclDeadline) continue;

    ra.staff = 'Rクリーン';
    ra.status = '外注';
  }

  // --- Phase 4 ---
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

        var tmpStaff = rAsgn.staff;
        var tmpStatus = rAsgn.status;
        rAsgn.staff = swapAsgn.staff;
        rAsgn.status = swapAsgn.status;
        swapAsgn.staff = tmpStaff;
        swapAsgn.status = tmpStatus;

        staffIdxs.splice(bestSwap, 1);
        staffIdxs.push(rIdx);
        rclIdxs[rx] = swapIdx;
      }
    }
  }

  allAssignments.sort(function (a, b) {
    if (a.dateStr !== b.dateStr) return a.dateStr < b.dateStr ? -1 : 1;
    if (a.unit !== b.unit) return a.unit < b.unit ? -1 : 1;
    return 0;
  });

  return allAssignments;
}
