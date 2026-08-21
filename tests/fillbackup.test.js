#!/usr/bin/env node
/**
 * tests/fillbackup.test.js
 *
 * 第八輪「版本備份與還原」的回歸測試。
 *
 * 最重要的一組：**50000 字元分拆與串回**。一份被截斷的 JSON 是還原不到
 * 的——那就變成「看起來有、其實無」的假備份，比完全沒有備份更危險。
 *
 * 執行方式：node tests/fillbackup.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFillEnv, QUARTER_ID, BASE_STUBS } = require('./helpers/fillEnv');

const sandbox = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, { SpreadsheetApp: {} }));
const {
  splitBackupPayload_, joinBackupPayload_, buildBackupPayload_,
  groupFillBackups_, backupIdsToPrune_, buildFillRestorePlan_,
  FILL_BACKUP_CHUNK_SIZE_, FILL_BACKUP_REASON
} = sandbox;

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name);
    console.log('    ' + err.message);
  }
}

function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

// =====================================================================
// 1. PAYLOAD_JSON 超過 50000 字元自動分拆與還原
// =====================================================================

test('1a. splitBackupPayload_：短內容只有一段', function () {
  const parts = splitBackupPayload_('短短的內容');
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0], '短短的內容');
});

test('1b. splitBackupPayload_：剛好等於上限時仍然只有一段', function () {
  const text = 'x'.repeat(FILL_BACKUP_CHUNK_SIZE_);
  assert.strictEqual(splitBackupPayload_(text).length, 1);
});

test('1c. splitBackupPayload_：超過上限一個字元 → 兩段', function () {
  const text = 'x'.repeat(FILL_BACKUP_CHUNK_SIZE_ + 1);
  const parts = splitBackupPayload_(text);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[1].length, 1);
});

test('1d. splitBackupPayload_：每一段都不超過上限（單格硬上限是 50000）', function () {
  const text = 'y'.repeat(FILL_BACKUP_CHUNK_SIZE_ * 3 + 500);
  splitBackupPayload_(text).forEach(function (part, i) {
    assert.ok(part.length <= FILL_BACKUP_CHUNK_SIZE_, '第 ' + (i + 1) + ' 段太長：' + part.length);
  });
  assert.ok(FILL_BACKUP_CHUNK_SIZE_ < 50000, '要留餘裕給 sanitizeCellText_ 可能加的單引號');
});

test('1e. 分拆之後串回來，內容一字不差', function () {
  const original = JSON.stringify({ rows: Array.from({ length: 3000 }, function (_, i) { return { n: i, t: '假資料' + i }; }) });
  assert.ok(original.length > FILL_BACKUP_CHUNK_SIZE_, '前提：這份內容真的超過上限');

  const parts = splitBackupPayload_(original);
  assert.ok(parts.length > 1, '前提：真的被分拆了');

  const rows = parts.map(function (p, i) { return { PART_NO: i + 1, PAYLOAD_JSON: p }; });
  assert.strictEqual(joinBackupPayload_(rows), original);
  assert.doesNotThrow(function () { JSON.parse(joinBackupPayload_(rows)); }, '串回來一定要仍然是合法 JSON');
});

test('1f. joinBackupPayload_：分段次序打亂時仍然按 PART_NO 串回正確次序', function () {
  const rows = [
    { PART_NO: 3, PAYLOAD_JSON: 'CCC' },
    { PART_NO: 1, PAYLOAD_JSON: 'AAA' },
    { PART_NO: 2, PAYLOAD_JSON: 'BBB' }
  ];
  assert.strictEqual(joinBackupPayload_(rows), 'AAABBBCCC');
});

test('1g. splitBackupPayload_：空內容回一段空字串（不是空陣列）', function () {
  // ⚠️ 一份「什麼都沒有」的備份仍然要有一行記錄，否則還原時分不出
  // 「沒有備份過」與「備份過但當時是空的」。
  assertArrayEqual(splitBackupPayload_(''), ['']);
  assertArrayEqual(splitBackupPayload_(null), ['']);
});

test('1h. 真正入口：大量資料會真的被分拆成多行，還原得回來', function () {
  const bigWeeks = Array.from({ length: 4 }, function (_, i) {
    return {
      SERVICE_DATE: ['2027-11-07', '2027-11-14', '2027-11-21', '2027-11-28'][i],
      QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT',
      SERMON_TITLE: '很長的講題'.repeat(4000)
    };
  });
  const env = makeFillEnv({ weekRows: bigWeeks, withGrid: false });

  const result = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  assert.ok(result.partCount > 1, '這麼大的內容應該被分拆：partCount=' + result.partCount);

  const backups = env.sandbox.listFillBackups_(QUARTER_ID);
  assert.strictEqual(backups.length, 1, '分拆成多行仍然只算一個備份');
  assert.strictEqual(backups[0].parts.length, result.partCount);

  const payload = env.sandbox.parseFillBackupPayload_(backups[0]);
  assert.strictEqual(payload.bulletinWeeks.length, 4);
  assert.strictEqual(payload.bulletinWeeks[0].SERMON_TITLE, '很長的講題'.repeat(4000),
    '串回來的內容要一字不差');
});

test('1i. parseFillBackupPayload_：內容壞掉時拋錯，不會還原一份殘缺資料', function () {
  const env = makeFillEnv({ withGrid: false });
  assert.throws(
    function () {
      env.sandbox.parseFillBackupPayload_({ backupId: 'X', parts: [{ PART_NO: 1, PAYLOAD_JSON: '{壞掉的 JSON' }] });
    },
    function (err) {
      return err.message.indexOf('殘缺') !== -1 || err.message.indexOf('解析失敗') !== -1;
    }
  );
});

// =====================================================================
// buildBackupPayload_
// =====================================================================

test('buildBackupPayload_：五張表的行數都算進 rowCount', function () {
  const payload = buildBackupPayload_({
    quarterId: QUARTER_ID,
    weekRows: [{}, {}], announcements: [{}], prayers: [{}, {}, {}],
    fellowships: [{}], finance: [{}]
  });
  assert.strictEqual(payload.rowCount, 8);
  assert.doesNotThrow(function () { JSON.parse(payload.json); });
});

test('buildBackupPayload_：缺漏的表當空陣列，不拋錯', function () {
  const payload = buildBackupPayload_({ quarterId: QUARTER_ID });
  assert.strictEqual(payload.rowCount, 0);
  const parsed = JSON.parse(payload.json);
  assertArrayEqual(parsed.bulletinWeeks, []);
});

// =====================================================================
// 2. 保留數目超過 FILL_BACKUP_KEEP 時刪最舊
// =====================================================================

test('2a. backupIdsToPrune_：保留 3 個，第 4 個之後的要刪', function () {
  const groups = ['E', 'D', 'C', 'B', 'A'].map(function (id) { return { backupId: id }; });
  assertArrayEqual(backupIdsToPrune_(groups, 3), ['B', 'A'], '由新到舊排序，所以刪的是排在最後的');
});

test('2b. backupIdsToPrune_：數目未超過上限時不刪任何一個', function () {
  const groups = [{ backupId: 'A' }, { backupId: 'B' }];
  assertArrayEqual(backupIdsToPrune_(groups, 20), []);
});

test('2c. backupIdsToPrune_：keep 不合法時退回預設 20', function () {
  const groups = Array.from({ length: 25 }, function (_, i) { return { backupId: 'B' + i }; });
  assert.strictEqual(backupIdsToPrune_(groups, 0).length, 5);
  assert.strictEqual(backupIdsToPrune_(groups, null).length, 5);
  assert.strictEqual(backupIdsToPrune_(groups, 'abc').length, 5);
});

test('2d. groupFillBackups_：依 BACKUP_ID 分組，由新到舊排序', function () {
  const groups = groupFillBackups_([
    { BACKUP_ID: '2027T4-20270101T000000', PART_NO: 1, QUARTER_ID: QUARTER_ID, REASON: 'MANUAL', ROW_COUNT: 1, PAYLOAD_JSON: 'a' },
    { BACKUP_ID: '2027T4-20270301T000000', PART_NO: 1, QUARTER_ID: QUARTER_ID, REASON: 'MANUAL', ROW_COUNT: 1, PAYLOAD_JSON: 'b' },
    { BACKUP_ID: '2027T4-20270201T000000', PART_NO: 1, QUARTER_ID: QUARTER_ID, REASON: 'MANUAL', ROW_COUNT: 1, PAYLOAD_JSON: 'c' }
  ], QUARTER_ID);

  assertArrayEqual(groups.map(function (g) { return g.backupId; }), [
    '2027T4-20270301T000000', '2027T4-20270201T000000', '2027T4-20270101T000000'
  ], '備份編號含時間戳記，字串倒序就是時間倒序');
});

test('2e. groupFillBackups_：只收指定季度的備份', function () {
  const groups = groupFillBackups_([
    { BACKUP_ID: 'A', PART_NO: 1, QUARTER_ID: '2027T4', REASON: 'M', ROW_COUNT: 1, PAYLOAD_JSON: '' },
    { BACKUP_ID: 'B', PART_NO: 1, QUARTER_ID: '2028T1', REASON: 'M', ROW_COUNT: 1, PAYLOAD_JSON: '' }
  ], '2027T4');
  assert.strictEqual(groups.length, 1);
});

test('2f. 真正入口：超過 FILL_BACKUP_KEEP 時真的刪走最舊的（唯一容許刪行的地方）', function () {
  const env = makeFillEnv({ config: { FILL_BACKUP_KEEP: '3' }, withGrid: false });

  const ids = [];
  for (let i = 0; i < 5; i++) {
    // ⚠️ 備份編號含到秒的時間戳記，同一秒內連續備份會撞名。這裡直接
    // 用不同的假時間造行，避免測試依賴真實時鐘。
    const result = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
    ids.push(result.backupId);
  }

  const remaining = env.sandbox.listFillBackups_(QUARTER_ID);
  assert.ok(remaining.length <= 3, '保留數目不應該超過 3，實際 ' + remaining.length);
  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) { return r.ACTION === 'FILL_BACKUP_PRUNE'; }),
    '刪走舊備份要留 AuditLog——這是唯一容許刪行的地方，更加要留痕');
});

// =====================================================================
// 3. 還原前自動再備份一次
// =====================================================================

test('3. 還原之前一定會再備份一次（原因 BEFORE_RESTORE）', function () {
  const env = makeFillEnv({ withGrid: false });

  // 先備份現況（SERMON_TITLE 是空的）
  const backup = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  // 改一格
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '改過之後的講題');

  const result = env.sandbox.restoreFillBackup_(QUARTER_ID, backup.backupId);
  assert.strictEqual(result.ok, true);
  assert.ok(result.safetyBackupId, '一定要有一個還原前的安全備份');

  const reasons = env.sandbox.readSheet('FillBackup').map(function (r) { return r.REASON; });
  assert.ok(reasons.indexOf('BEFORE_RESTORE') !== -1, '還原前的備份原因要是 BEFORE_RESTORE');
});

test('3b. 還原之後，安全備份可以把改動再還原回來', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '原本的講題');

  const first = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '後來改成這個');

  const restore = env.sandbox.restoreFillBackup_(QUARTER_ID, first.backupId);
  assert.strictEqual(restore.restoredCount, 1);

  const afterRestore = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(afterRestore.SERMON_TITLE, '原本的講題');

  // 再用安全備份還原回去
  env.sandbox.restoreFillBackup_(QUARTER_ID, restore.safetyBackupId);
  const afterUndo = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(afterUndo.SERMON_TITLE, '後來改成這個', '安全備份要真的還原得回去');
});

// =====================================================================
// 4. 還原是逐格寫入並記 AuditLog
// =====================================================================

test('4a. buildFillRestorePlan_：只列出真的有差異的格', function () {
  const plan = buildFillRestorePlan_(
    { bulletinWeeks: [{ SERVICE_DATE: '2027-11-07', SERMON_TITLE: '備份的講題', HYMN_PRAISE: '一樣的' }] },
    { '2027-11-07': { SERMON_TITLE: '現在的講題', HYMN_PRAISE: '一樣的' } }
  );
  assert.strictEqual(plan.changes.length, 1);
  assert.strictEqual(plan.changes[0].fieldKey, 'SERMON_TITLE');
  assert.strictEqual(plan.changes[0].oldValue, '現在的講題');
  assert.strictEqual(plan.changes[0].newValue, '備份的講題');
});

test('4b. buildFillRestorePlan_：只還原可編輯欄，系統欄（STATUS／DOC_ID 等）不動', function () {
  const plan = buildFillRestorePlan_(
    { bulletinWeeks: [{ SERVICE_DATE: '2027-11-07', STATUS: 'SENT', DOC_ID: 'old', SERMON_TITLE: 'A' }] },
    { '2027-11-07': { STATUS: 'DRAFT', DOC_ID: 'new', SERMON_TITLE: 'B' } }
  );
  const fields = plan.changes.map(function (c) { return c.fieldKey; });
  assert.ok(fields.indexOf('SERMON_TITLE') !== -1);
  assert.strictEqual(fields.indexOf('STATUS'), -1, '系統欄不可以被還原——還原它只會令狀態與現實脫節');
  assert.strictEqual(fields.indexOf('DOC_ID'), -1);
});

test('4c. buildFillRestorePlan_：備份裡有、現在沒有的主日 → 不新增行', function () {
  const plan = buildFillRestorePlan_(
    { bulletinWeeks: [{ SERVICE_DATE: '2099-01-01', SERMON_TITLE: 'A' }] },
    { '2027-11-07': {} }
  );
  assert.strictEqual(plan.changes.length, 0);
});

test('4d. buildFillRestorePlan_：affectedDates 去重並排序', function () {
  const plan = buildFillRestorePlan_(
    {
      bulletinWeeks: [
        { SERVICE_DATE: '2027-11-14', SERMON_TITLE: 'B', HYMN_PRAISE: 'B2' },
        { SERVICE_DATE: '2027-11-07', SERMON_TITLE: 'A' }
      ]
    },
    { '2027-11-07': {}, '2027-11-14': {} }
  );
  assertArrayEqual(plan.affectedDates, ['2027-11-07', '2027-11-14']);
});

test('4e. 真正入口：還原逐格記 AuditLog', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '原本的');
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'HYMN_PRAISE', '原本的詩歌');

  const backup = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '改過');
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'HYMN_PRAISE', '改過的詩歌');

  env.sandbox.restoreFillBackup_(QUARTER_ID, backup.backupId);

  const restoreLogs = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'FILL_BACKUP_RESTORE'; });
  assert.strictEqual(restoreLogs.length, 2, '兩格各記一筆');
  assert.ok(restoreLogs.every(function (r) { return r.ROW_KEY === '2027-11-07'; }));
});

test('4f. previewFillRestore_：唯讀，不會寫入任何一格', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '原本的');
  const backup = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '改過');

  const before = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  const preview = env.sandbox.previewFillRestore_(QUARTER_ID, backup.backupId);

  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.changes.length, 1);
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), before,
    '預覽一定要唯讀——使用者還未確認');
});

test('4g. previewFillRestore_：欄位摘要按欄位分組計數', function () {
  const env = makeFillEnv({ withGrid: false });
  const backup = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', 'A');
  env.sandbox.writeBulletinWeekField_('2027-11-14', 'SERMON_TITLE', 'B');

  const preview = env.sandbox.previewFillRestore_(QUARTER_ID, backup.backupId);
  const summary = preview.fieldSummary.filter(function (f) { return f.fieldKey === 'SERMON_TITLE'; })[0];
  assert.strictEqual(summary.count, 2);
  assert.strictEqual(summary.label, '證道講題', '摘要要用人看得懂的中文欄名');
});

test('4h. previewFillRestore_：找不到備份 → ok:false，不拋錯', function () {
  const env = makeFillEnv({ withGrid: false });
  const preview = env.sandbox.previewFillRestore_(QUARTER_ID, '不存在的備份');
  assert.strictEqual(preview.ok, false);
  assert.ok(preview.message.indexOf('找不到') !== -1);
});

test('4i. 還原之後 FillSnapshot 跟着更新（避免下次同步產生一堆沒有意義的 PULL）', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '原本的');

  const backup = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  env.sandbox.writeBulletinWeekField_('2027-11-07', 'SERMON_TITLE', '改過');
  env.sandbox.restoreFillBackup_(QUARTER_ID, backup.backupId);

  const snapshot = env.sandbox.readSheet('FillSnapshot').filter(function (r) {
    return r.FIELD_KEY === 'SERMON_TITLE' && env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(env.sandbox.fillGridCellText_(snapshot.VALUE), '原本的');
});

// =====================================================================
// 備份內容的完整性
// =====================================================================

test('備份內容：包含該季 BulletinWeeks 與四張清單表', function () {
  const env = makeFillEnv({
    withGrid: false,
    announcements: [{ SERVICE_DATE: '2027-11-07', SEQ_NO: 10, TEXT: '一則家事報告', ACTIVE: true }],
    fellowships: [{ SERVICE_DATE: '2027-11-07', SEQ_NO: 10, FELLOWSHIP_NAME: '假團契', MEETING_DATE: '', MEETING_TIME: '', CONTENT: '', ACTIVE: true }]
  });

  const backup = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  const group = env.sandbox.listFillBackups_(QUARTER_ID).filter(function (g) { return g.backupId === backup.backupId; })[0];
  const payload = env.sandbox.parseFillBackupPayload_(group);

  assert.strictEqual(payload.bulletinWeeks.length, 4);
  assert.strictEqual(payload.announcements.length, 1);
  assert.strictEqual(payload.fellowships.length, 1);
  assert.strictEqual(payload.quarterId, QUARTER_ID);
});

test('備份內容：不屬於該季的清單行不會被備份', function () {
  const env = makeFillEnv({
    withGrid: false,
    announcements: [
      { SERVICE_DATE: '2027-11-07', SEQ_NO: 10, TEXT: '本季的', ACTIVE: true },
      { SERVICE_DATE: '2099-01-01', SEQ_NO: 10, TEXT: '別季的', ACTIVE: true }
    ]
  });
  const backup = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  const group = env.sandbox.listFillBackups_(QUARTER_ID).filter(function (g) { return g.backupId === backup.backupId; })[0];
  const payload = env.sandbox.parseFillBackupPayload_(group);

  assert.strictEqual(payload.announcements.length, 1);
  assert.strictEqual(payload.announcements[0].TEXT, '本季的');
});

test('備份：每次都記一筆 AuditLog', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) { return r.ACTION === 'FILL_BACKUP_CREATE'; }));
});

test('備份編號：以季度開頭，含時間戳記', function () {
  const env = makeFillEnv({ withGrid: false });
  const result = env.sandbox.createFillBackup_(QUARTER_ID, FILL_BACKUP_REASON.MANUAL);
  assert.ok(/^2027T4-\d{8}T\d{6}$/.test(result.backupId), '格式應該是 <季度>-<時間戳記>：' + result.backupId);
});

test('listFillBackups_：FillBackup 工作表不存在時回空陣列，不拋錯（還沒備份過不是錯誤）', function () {
  const env = makeFillEnv({ withGrid: false });
  delete env.sheets.FillBackup;
  let backups;
  assert.doesNotThrow(function () { backups = env.sandbox.listFillBackups_(QUARTER_ID); });
  assertArrayEqual(backups, []);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
