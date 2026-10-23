#!/usr/bin/env node
/**
 * tests/stage3.test.js
 *
 * 第二批階段 3 的回歸測試：講員表格（Google Form）。
 *
 * 一律經真正入口：
 *   - `onSpeakerFormSubmit_(e)`　處理一份答案（e 是假的表單提交事件）；
 *   - `apiCreateSpeakerForm()`／`apiRefreshSpeakerFormDates()`／`apiGetSpeakerFormStatus()`；
 *   - `loadWeekForWebApp_()`／`buildBulletinModel_()`　講員核對警告；
 *   - `buildGoLiveChecklist_()`／`selfCheckSpeakerFormItem_()`　兩個檢測。
 *
 * 前端函式用「BEGIN／END 標記」從 Script.html 抽出來，在假 DOM 上真的執行。
 *
 * 執行方式：node tests/stage3.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const contentEnv = require('./helpers/contentEnv');
const { makeFakeFormApp, makeFormSubmitEvent } = require('./helpers/fakeForm');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err));
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

/** 沙盒裏出來的陣列／物件和測試這邊不同 realm，deepStrictEqual 會誤判，先轉成純資料。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const D = '2027-11-07';
const D_NEXT = '2027-11-14';
const CONTENT_FOLDER = 'CONTENT_FOLDER_ID';
const SHARED_FOLDER = 'SHARED_DRIVE_FOLDER';

// =====================================================================
// 環境
// =====================================================================

const FAKE_LOCK = {
  getScriptLock: function () {
    return { tryLock: function () { return true; }, releaseLock: function () {} };
  }
};

/** 假的 Drive 進階服務：只實作講員表格用得到的 get／update，並記下呼叫。 */
function makeAdvancedDrive(options) {
  const o = options || {};
  const calls = { get: [], update: [] };
  return {
    calls: calls,
    Files: {
      get: function (id, args) {
        calls.get.push({ id: id, args: args });
        if (!args || args.supportsAllDrives !== true) throw new Error('假的 Drive.Files.get：缺少 supportsAllDrives');
        if (o.failGet) throw new Error('假的 Drive.Files.get 失敗');
        const sharedFolders = o.sharedFolders || [];
        return { id: id, driveId: sharedFolders.indexOf(id) !== -1 ? 'SHARED_DRIVE_1' : undefined, parents: ['MY_DRIVE_ROOT'] };
      },
      update: function (resource, id, media, args) {
        calls.update.push({ resource: resource, id: id, args: args });
        if (!args || args.supportsAllDrives !== true) throw new Error('假的 Drive.Files.update：缺少 supportsAllDrives');
        if (o.failUpdate) throw new Error('假的 Drive.Files.update 失敗');
        return { id: id };
      }
    }
  };
}

function preacherOptions(nameD, nameNext) {
  const assignments = [];
  if (nameD) {
    assignments.push({
      QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: D, PostID: 'PREACHER',
      SlotIndex: 1, PersonID: 'P9010', PersonNameSnapshot: nameD, AssignSource: 'AUTO', Locked: false
    });
  }
  if (nameNext) {
    assignments.push({
      QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: D_NEXT, PostID: 'PREACHER',
      SlotIndex: 1, PersonID: 'P9011', PersonNameSnapshot: nameNext, AssignSource: 'AUTO', Locked: false
    });
  }
  return {
    rosterAssignments: assignments,
    rosterPosts: [
      { PostID: 'PREACHER', PostName_TC: '講員', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 30, Active: true, EmptyDisplay: 'PENDING' }
    ]
  };
}

function weekRowInput(iso, extra) {
  return Object.assign({ SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }, extra || {});
}

/**
 * 沒有內容表的完整環境（職事表有講員、有 ADMIN 收件人、有假 FormApp 與假 Drive 進階服務）。
 * Args:
 *   o {{week:Object=, nextWeek:Object=, config:Object=, preacher:string=, nextPreacher:string=,
 *      formOptions:Object=, driveOptions:Object=, weekRows:Object[]=, mailCalls:*}=}
 */
function makeEnv(o) {
  const opts = o || {};
  const forms = makeFakeFormApp(opts.formOptions);
  const drive = makeAdvancedDrive(Object.assign({ sharedFolders: [SHARED_FOLDER, CONTENT_FOLDER] }, opts.driveOptions || {}));
  const preacher = opts.preacher === undefined ? '甲牧師' : opts.preacher;
  const env = makeFillEnv(Object.assign({
    withGrid: false,
    weekRows: opts.weekRows || [weekRowInput(D, opts.week), weekRowInput(D_NEXT, opts.nextWeek)],
    config: Object.assign({ DRY_RUN: 'TRUE', WEBAPP_URL: 'https://example.invalid/webapp', CHURCH_NAME: '假教會' }, opts.config || {}),
    extraStubs: { FormApp: forms.FormApp, LockService: FAKE_LOCK },
    driveAdvanced: drive
  }, preacherOptions(preacher, opts.nextPreacher)));
  return { sandbox: env.sandbox, sheets: env.sheets, mail: env.mail, triggers: env.triggers, forms: forms, drive: drive };
}

/** 標題用 Config 預設值的答案事件。 */
function speakerEvent(answer, meta) {
  const a = Object.assign({
    date: D, speaker: '甲牧師', scripture: '約翰福音 3:16', title: '神愛世人', notes: ''
  }, answer || {});
  return makeFormSubmitEvent({
    '主日日期': a.date, '講員': a.speaker, '讀經經文': a.scripture, '證道講題': a.title, '備註': a.notes
  }, meta);
}

function submissions(env) {
  return plain(env.sandbox.readSheet('SpeakerFormSubmissions').map(function (r) {
    return { date: env.sandbox.fillGridCellText_(r.SERVICE_DATE), email: r.RESPONDENT_EMAIL, speaker: r.SPEAKER_NAME,
      scripture: r.SCRIPTURE_REF, title: r.SERMON_TITLE, notes: r.NOTES, result: r.RESULT, detail: r.DETAIL, active: r.ACTIVE };
  }));
}

function weekRowOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === iso;
  })[0];
}

function auditOf(env, action) {
  return env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === action; });
}

function snapshotReasons(env, iso) {
  return plain(env.sandbox.listWeekSnapshotsForWebApp_(iso).versions.map(function (v) { return v.reason; }));
}

// =====================================================================
// 1. 純函式
// =====================================================================

console.log('\n純函式');

test('buildSpeakerFormDateOptions_：略過已封存與已過去、由近到遠只取 N 個；有特別主日附名稱', function () {
  const sb = makeEnv().sandbox;
  const rows = [
    { SERVICE_DATE: '2028-05-28', SPECIAL_TYPE: '瀏覽器測試合堂', ARCHIVED: false },
    { SERVICE_DATE: '2028-04-09', SPECIAL_TYPE: '', ARCHIVED: false },
    { SERVICE_DATE: '2028-04-02', SPECIAL_TYPE: '', ARCHIVED: true },
    { SERVICE_DATE: '2028-03-26', SPECIAL_TYPE: '', ARCHIVED: false },
    { SERVICE_DATE: '2028-04-16', SPECIAL_TYPE: '', ARCHIVED: false },
    { SERVICE_DATE: '2028-04-09', SPECIAL_TYPE: '', ARCHIVED: false }
  ];
  const all = plain(sb.buildSpeakerFormDateOptions_(rows, '2028-04-09', 16, '{{DATE}}（{{SPECIAL}}）'));
  assert.deepStrictEqual(all.map(function (o) { return o.label; }), ['2028-04-09', '2028-04-16', '2028-05-28（瀏覽器測試合堂）']);
  assert.deepStrictEqual(all.map(function (o) { return o.isoDate; }), ['2028-04-09', '2028-04-16', '2028-05-28']);
  const two = plain(sb.buildSpeakerFormDateOptions_(rows, '2028-04-09', 2, '{{DATE}}（{{SPECIAL}}）'));
  assert.deepStrictEqual(two.map(function (o) { return o.isoDate; }), ['2028-04-09', '2028-04-16']);
  assert.strictEqual(sb.buildSpeakerFormDateOptions_(rows, '2028-04-09', '亂寫', '{{DATE}}').length, 3, '不是正整數就用 16');
});

test('parseSpeakerFormDateChoice_：取開頭的 yyyy-MM-dd，後面的名稱不理；認不出或不存在的日期回空', function () {
  const sb = makeEnv().sandbox;
  assert.strictEqual(sb.parseSpeakerFormDateChoice_('2028-05-28（瀏覽器測試合堂）'), '2028-05-28');
  assert.strictEqual(sb.parseSpeakerFormDateChoice_(' 2028-04-09 '), '2028-04-09');
  assert.strictEqual(sb.parseSpeakerFormDateChoice_('四月九日'), '');
  assert.strictEqual(sb.parseSpeakerFormDateChoice_('2028-13-40'), '');
  assert.strictEqual(sb.parseSpeakerFormDateChoice_(null), '');
});

test('normalizeSpeakerName_：去尊稱（長的先去）、去全形與半形空白、英文不分大小寫', function () {
  const sb = makeEnv().sandbox;
  const h = ['牧師', '傳道', '弟兄', '姊妹', '傳道人'];
  assert.strictEqual(sb.normalizeSpeakerName_('甲 牧師', h), '甲');
  assert.strictEqual(sb.normalizeSpeakerName_('甲　傳道', h), '甲');
  assert.strictEqual(sb.normalizeSpeakerName_('乙傳道人', h), '乙', '「傳道人」比「傳道」長，先去');
  assert.strictEqual(sb.normalizeSpeakerName_('John Smith', []), 'johnsmith');
  assert.strictEqual(sb.normalizeSpeakerName_(null, h), '');
});

test('buildSpeakerMismatchWarning_：正規化後相同 → 無警告；不同 → 照指定字眼警告；事奉框空白顯示（空白）', function () {
  const sb = makeEnv().sandbox;
  const h = ['牧師', '傳道'];
  assert.strictEqual(sb.buildSpeakerMismatchWarning_('甲 牧師', '甲牧師', h), null);
  const w = sb.buildSpeakerMismatchWarning_('乙傳道', '甲牧師', h);
  assert.strictEqual(w.code, 'SPEAKER_FORM_MISMATCH');
  assert.strictEqual(w.message, '講員表格填的講員是「乙傳道」，事奉框是「甲牧師」。如果真的換了講員，請在事奉框改「講員」；職事表要另外更正。');
  assert.ok(sb.buildSpeakerMismatchWarning_('乙傳道', '', h).message.indexOf('事奉框是「（空白）」') !== -1);
  assertWrittenChinese(assert, '講員核對警告', [w.message]);
});

test('speakerNameFromSlots_：取講員崗位全部位次的名字，多位用頓號；沒有就是空字串', function () {
  const sb = makeEnv().sandbox;
  assert.strictEqual(sb.speakerNameFromSlots_({ PREACHER: [{ personName: '甲牧師' }, { personName: ' ' }, { personName: '乙傳道' }] }), '甲牧師、乙傳道');
  assert.strictEqual(sb.speakerNameFromSlots_({}), '');
  assert.strictEqual(sb.speakerNameFromSlots_(null), '');
});

test('pickLatestSpeakerAnswer_：只看該主日、有效、非出錯的；提交時間相同以較後的一行為準', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  const at = function (ms) { return vm.runInContext('new Date(' + ms + ')', sb); };
  const rows = [
    { SERVICE_DATE: '2027-11-07', TIMESTAMP: at(1000), SPEAKER_NAME: '甲', ACTIVE: true, RESULT: 'APPLIED' },
    { SERVICE_DATE: '2027-11-07', TIMESTAMP: at(3000), SPEAKER_NAME: '乙', ACTIVE: true, RESULT: 'APPLIED' },
    { SERVICE_DATE: '2027-11-07', TIMESTAMP: at(5000), SPEAKER_NAME: '丙', ACTIVE: false, RESULT: 'APPLIED' },
    { SERVICE_DATE: '2027-11-07', TIMESTAMP: at(6000), SPEAKER_NAME: '丁', ACTIVE: true, RESULT: 'ERROR' },
    { SERVICE_DATE: '2027-11-14', TIMESTAMP: at(9000), SPEAKER_NAME: '戊', ACTIVE: true, RESULT: 'APPLIED' }
  ];
  assert.strictEqual(sb.pickLatestSpeakerAnswer_(rows, '2027-11-07').SPEAKER_NAME, '乙');
  assert.strictEqual(sb.pickLatestSpeakerAnswer_(rows, '2030-01-06'), null);
  const tie = [
    { SERVICE_DATE: '2027-11-07', TIMESTAMP: at(1000), SPEAKER_NAME: '先', ACTIVE: true, RESULT: 'APPLIED' },
    { SERVICE_DATE: '2027-11-07', TIMESTAMP: at(1000), SPEAKER_NAME: '後', ACTIVE: true, RESULT: 'APPLIED' }
  ];
  assert.strictEqual(sb.pickLatestSpeakerAnswer_(tie, '2027-11-07').SPEAKER_NAME, '後');
});

test('fillSpeakerFormPattern_：換掉已提供的 {{KEY}}，沒提供的原樣保留', function () {
  const sb = makeEnv().sandbox;
  assert.strictEqual(sb.fillSpeakerFormPattern_('{{A}}-{{B}}-{{C}}', { A: '一', B: '二' }), '一-二-{{C}}');
});

test('SPEAKER_FORM_RESULTS：六個結果代碼都有中文名稱（書面語）', function () {
  const sb = makeEnv().sandbox;
  ['APPLIED', 'UNCHANGED', 'BLOCKED_BY_OVERRIDE', 'SKIPPED_PAST', 'NO_WEEK', 'ERROR'].forEach(function (code) {
    assert.ok(sb.speakerFormResultLabel_(code) !== code, code + ' 沒有中文名稱');
  });
  assertWrittenChinese(assert, '處理結果名稱', Object.keys(sb.SPEAKER_FORM_RESULTS).map(function (k) { return sb.SPEAKER_FORM_RESULTS[k]; }));
});

test('Config：十六個新鍵都有預設值與說明；題目字眼、尊稱、通知主旨都在 Config；ID 與連結預設空白', function () {
  const sb = makeEnv().sandbox;
  const seed = {};
  sb.DEFAULTS.forEach(function (d) { seed[d.key] = d; });
  const keys = ['SPEAKER_FORM_ID', 'SPEAKER_FORM_URL', 'SPEAKER_FORM_FOLDER_ID', 'SPEAKER_FORM_TITLE', 'SPEAKER_FORM_DESCRIPTION',
    'SPEAKER_FORM_CONFIRMATION', 'SPEAKER_FORM_WEEKS_AHEAD', 'SPEAKER_FORM_NOTIFY_GROUPS', 'SPEAKER_FORM_Q_DATE', 'SPEAKER_FORM_Q_SPEAKER',
    'SPEAKER_FORM_Q_SCRIPTURE', 'SPEAKER_FORM_Q_TITLE', 'SPEAKER_FORM_Q_NOTES', 'SPEAKER_FORM_DATE_SPECIAL_PATTERN',
    'SPEAKER_FORM_NOTIFY_SUBJECT', 'SPEAKER_NAME_HONORIFICS'];
  keys.forEach(function (k) {
    assert.ok(seed[k], '缺少 ' + k);
    assert.ok(String(seed[k].note).length > 10, k + ' 沒有說明');
  });
  assert.strictEqual(seed.SPEAKER_FORM_WEEKS_AHEAD.value, '16');
  assert.strictEqual(seed.SPEAKER_FORM_NOTIFY_GROUPS.value, 'ADMIN');
  ['SPEAKER_FORM_ID', 'SPEAKER_FORM_URL', 'SPEAKER_FORM_FOLDER_ID'].forEach(function (k) { assert.strictEqual(seed[k].value, ''); });
  assertWrittenChinese(assert, '講員表格 Config 預設值與說明',
    keys.map(function (k) { return seed[k].note; }).concat([seed.SPEAKER_FORM_TITLE.value, seed.SPEAKER_FORM_DESCRIPTION.value, seed.SPEAKER_FORM_CONFIRMATION.value]));
});

test('SpeakerFormSubmissions 欄位依次是指定的十個，新工作表排在最後', function () {
  const sb = makeEnv().sandbox;
  assert.deepStrictEqual(plain(sb.COLUMNS.SPEAKER_FORM_SUBMISSIONS.keys), [
    'TIMESTAMP', 'SERVICE_DATE', 'RESPONDENT_EMAIL', 'SPEAKER_NAME', 'SCRIPTURE_REF', 'SERMON_TITLE', 'NOTES', 'RESULT', 'DETAIL', 'ACTIVE'
  ]);
  const ids = Object.keys(sb.SHEETS);
  assert.strictEqual(ids[ids.length - 1], 'SPEAKER_FORM_SUBMISSIONS');
});

// =====================================================================
// 2. 處理答案（真入口 onSpeakerFormSubmit_）——沒有內容表
// =====================================================================

console.log('\n處理答案：本季沒有內容表');

test('沒有內容表：直接寫 BulletinWeeks 兩格；寫入前存 SPEAKER_FORM 版本；記答案、AuditLog、通知', function () {
  const env = makeEnv({ week: { SCRIPTURE_REF: '舊經文', SERMON_TITLE: '舊講題', PRELUDE: '序樂不動' } });
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ scripture: '羅馬書 8:28', title: '萬事互相效力', notes: '請預備投影' }));

  assert.strictEqual(result.result, 'APPLIED', JSON.stringify(result));
  const row = weekRowOf(env, D);
  assert.strictEqual(row.SCRIPTURE_REF, '羅馬書 8:28');
  assert.strictEqual(row.SERMON_TITLE, '萬事互相效力');
  assert.strictEqual(row.PRELUDE, '序樂不動', '其他欄位一格都不動');

  assert.deepStrictEqual(snapshotReasons(env, D), ['SPEAKER_FORM']);
  assert.strictEqual(env.sandbox.listWeekSnapshotsForWebApp_(D).versions[0].createdBy, 'speaker', '版本的建立者記答題者（表單提交觸發器裏查不到操作者）');
  const snap = env.sandbox.loadWeekSnapshot_(D, env.sandbox.listWeekSnapshotsForWebApp_(D).versions[0].snapshotId).payload;
  assert.strictEqual(snap.week.SERMON_TITLE, '舊講題', '版本記的是寫入之前的值');

  const subs = submissions(env);
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].date, D);
  assert.strictEqual(subs[0].email, 'speaker@church.example');
  assert.strictEqual(subs[0].speaker, '甲牧師');
  assert.strictEqual(subs[0].notes, '請預備投影');
  assert.strictEqual(subs[0].result, 'APPLIED');
  assert.strictEqual(subs[0].active, true);

  const audit = auditOf(env, 'SPEAKER_FORM_SUBMIT');
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].ACTOR, 'speaker@church.example');
  assert.strictEqual(audit[0].ROW_KEY, D);
  assert.strictEqual(audit[0].NEW_VALUE, 'APPLIED');
  assert.strictEqual(auditOf(env, 'SPEAKER_FORM_WRITE').length, 2, '直接寫 BulletinWeeks 的兩格各有一筆逐格記錄');
});

test('沒有內容表：答案與週報現在的內容一樣 → UNCHANGED，不存版本、不寫週報', function () {
  const env = makeEnv({ week: { SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '神愛世人' } });
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent());
  assert.strictEqual(result.result, 'UNCHANGED');
  assert.strictEqual(snapshotReasons(env, D).length, 0);
  assert.strictEqual(submissions(env)[0].result, 'UNCHANGED');
});

test('那一格有生效中的人手覆寫（FieldOverride）→ 不蓋過，BLOCKED_BY_OVERRIDE；另一格照寫', function () {
  const env = makeEnv({ week: { SCRIPTURE_REF: '舊經文', SERMON_TITLE: '內容表講題' } });
  // 幹事在填寫介面把講題改過（真入口：存檔會寫 FieldOverride）
  const loaded = env.sandbox.loadWeekForWebApp_(D);
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: loaded.lastSavedAt, week: { SERMON_TITLE: '幹事自己改的講題' },
    baseWeek: env.sandbox.baseWeekFor_(loaded.week, { SERMON_TITLE: '幹事自己改的講題' })
  });

  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ scripture: '新經文', title: '講員填的講題' }));
  assert.strictEqual(result.result, 'BLOCKED_BY_OVERRIDE');
  const row = weekRowOf(env, D);
  assert.strictEqual(row.SERMON_TITLE, '幹事自己改的講題', '覆寫不可以被蓋過');
  assert.strictEqual(row.SCRIPTURE_REF, '新經文', '沒有覆寫的那一格照寫');
  assert.ok(result.detail.indexOf('證道講題有人手覆寫') !== -1, result.detail);
  assert.strictEqual(submissions(env)[0].result, 'BLOCKED_BY_OVERRIDE');
});

test('兩格都被覆寫 → 一格都不寫、不存版本，BLOCKED_BY_OVERRIDE', function () {
  const env = makeEnv({ week: { SCRIPTURE_REF: 'A', SERMON_TITLE: 'B' } });
  const loaded = env.sandbox.loadWeekForWebApp_(D);
  const patch = { SCRIPTURE_REF: '覆寫經文', SERMON_TITLE: '覆寫講題' };
  env.sandbox.saveWeekFromWebApp_({ isoDate: D, lastSavedAt: loaded.lastSavedAt, week: patch, baseWeek: env.sandbox.baseWeekFor_(loaded.week, patch) });
  const before = snapshotReasons(env, D).length;
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent());
  assert.strictEqual(result.result, 'BLOCKED_BY_OVERRIDE');
  assert.strictEqual(snapshotReasons(env, D).length, before, '沒有東西要寫，不存新版本');
  assert.strictEqual(weekRowOf(env, D).SCRIPTURE_REF, '覆寫經文');
});

test('主日已過去 → SKIPPED_PAST：不寫週報、不存版本，答案照記、照通知', function () {
  const env = makeEnv({ weekRows: [weekRowInput('2020-01-05', { SERMON_TITLE: '舊' }), weekRowInput(D)] });
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ date: '2020-01-05' }));
  assert.strictEqual(result.result, 'SKIPPED_PAST');
  assert.strictEqual(weekRowOf(env, '2020-01-05').SERMON_TITLE, '舊');
  assert.strictEqual(snapshotReasons(env, '2020-01-05').length, 0);
  assert.strictEqual(submissions(env)[0].result, 'SKIPPED_PAST');
  const log = env.sandbox.readSheet('SendLog');
  assert.strictEqual(log.length, 1, '通知管理員（DRY_RUN 只寫 SendLog）');
  assert.ok(log[0].SUBJECT.indexOf('主日已過') !== -1, log[0].SUBJECT);
});

test('主日沒有週報那一行 → NO_WEEK，答案照記、照通知', function () {
  const env = makeEnv();
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ date: '2031-01-05' }));
  assert.strictEqual(result.result, 'NO_WEEK');
  assert.strictEqual(submissions(env)[0].result, 'NO_WEEK');
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 1);
});

test('這一期已經發佈（PublishLog 有記錄）→ 照寫，通知內加一句不會自動更新已發佈的 PDF', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' } });
  env.sandbox.writeSheet('PublishLog', [{
    SERVICE_DATE: env.sandbox.normalizeDate_(D), VERSION_NO: 1, PUBLISHED_AT: new Date(), PUBLISHED_BY: 'a',
    ARCHIVE_FILE_ID: 'ARC', IS_SELFTEST: false, FORCED: false
  }]);
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ title: '新講題' }));
  assert.strictEqual(result.result, 'APPLIED');
  assert.strictEqual(result.published, true);
  assert.strictEqual(weekRowOf(env, D).SERMON_TITLE, '新講題');
  const body = env.sandbox.readSheet('SendLog')[0].BODY_PREVIEW;
  assert.ok(body.indexOf('這一期已經發佈，表格的改動不會自動更新已發佈的 PDF。') !== -1, body);
});

test('自測發佈的記錄不算「已發佈」', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' } });
  env.sandbox.writeSheet('PublishLog', [{
    SERVICE_DATE: env.sandbox.normalizeDate_(D), VERSION_NO: 1, PUBLISHED_AT: new Date(), PUBLISHED_BY: 'a',
    ARCHIVE_FILE_ID: 'ARC', IS_SELFTEST: true, FORCED: false
  }]);
  assert.strictEqual(env.sandbox.onSpeakerFormSubmit_(speakerEvent({ title: '新' })).published, false);
});

test('題目字眼對不上（建立表格後在表格上改了題目）→ 答案照記為 ERROR 並通知，不會憑空消失', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' } });
  const event = makeFormSubmitEvent({ '主日日期': D, '講員': '甲牧師', '經文': 'x', '證道講題': 'y' });
  const result = env.sandbox.onSpeakerFormSubmit_(event);
  assert.strictEqual(result.result, 'ERROR');
  assert.ok(result.detail.indexOf('讀經經文') !== -1, '要講出找不到哪一題：' + result.detail);
  assert.strictEqual(submissions(env).length, 1);
  assert.strictEqual(weekRowOf(env, D).SERMON_TITLE, '舊', '一格都沒寫');
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 1);
});

test('認不出主日日期 → ERROR 並照記', function () {
  const env = makeEnv();
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ date: '下個主日' }));
  assert.strictEqual(result.result, 'ERROR');
  assert.ok(result.detail.indexOf('認不出主日日期') !== -1);
  assert.strictEqual(submissions(env)[0].date, '');
});

test('拿不到鎖 → 拋錯並記 ErrorLog，不處理這份答案', function () {
  const env = makeEnv();
  env.sandbox.LockService = { getScriptLock: function () { return { tryLock: function () { return false; }, releaseLock: function () {} }; } };
  assert.throws(function () { env.sandbox.onSpeakerFormSubmit_(speakerEvent()); }, /拿不到指令碼鎖/);
  assert.strictEqual(submissions(env).length, 0);
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'LOCK_TIMEOUT'; }).length, 1);
});

test('同一個主日兩份答案：兩份都記下來，講員核對以最新一份為準', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, preacher: '甲牧師' });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '乙傳道', title: '第一份' }), undefined);
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '甲牧師', title: '第二份' }));
  const subs = submissions(env);
  assert.strictEqual(subs.length, 2);
  assert.ok(subs.every(function (s) { return s.active === true; }), '舊的不停用');
  assert.strictEqual(weekRowOf(env, D).SERMON_TITLE, '第二份');
  const warnings = env.sandbox.buildBulletinModel_(D).warnings.filter(function (w) { return w.code === 'SPEAKER_FORM_MISMATCH'; });
  assert.strictEqual(warnings.length, 0, '最新一份（甲牧師）與事奉框一致');
});

// =====================================================================
// 3. 通知（DRY_RUN）
// =====================================================================

console.log('\n通知');

test('DRY_RUN=TRUE：完全不呼叫 MailApp，只寫 SendLog（STATUS 為 SPEAKER_FORM_NOTICE、DRY_RUN 為 TRUE）', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, config: { DRY_RUN: 'TRUE' } });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ title: '新講題' }));
  assert.strictEqual(env.mail.calls.length, 0, 'DRY_RUN 不可以寄出任何郵件');
  const log = env.sandbox.readSheet('SendLog');
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].STATUS, 'SPEAKER_FORM_NOTICE');
  assert.strictEqual(log[0].DRY_RUN, true);
  assert.strictEqual(log[0].RECIPIENT_EMAIL, 'admin@x.com', '只寄給 SPEAKER_FORM_NOTIFY_GROUPS（ADMIN）那一組');
});

test('DRY_RUN=FALSE：寄給 ADMIN 組每個人，內容有主日、講員、經文、講題、結果、核對、填寫介面連結', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, config: { DRY_RUN: 'FALSE' }, preacher: '甲牧師' });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '乙傳道', title: '新講題', notes: '備註內容' }));
  assert.strictEqual(env.mail.calls.length, 1);
  const mail = env.mail.calls[0];
  assert.strictEqual(mail.to, 'admin@x.com');
  assert.strictEqual(mail.subject, '假教會週報：講員表格新答案（' + D + '，已寫入週報）');
  ['主日：' + D, '答題者：speaker@church.example', '講員：乙傳道', '讀經經文：約翰福音 3:16', '證道講題：新講題', '備註：備註內容',
    '寫入結果：已寫入週報', '講員核對：⚠️ 講員表格填的講員是「乙傳道」，事奉框是「甲牧師」', '填寫介面：https://example.invalid/webapp']
    .forEach(function (piece) { assert.ok(mail.body.indexOf(piece) !== -1, '通知內容缺少：' + piece + '\n' + mail.body); });
  assert.ok(mail.htmlBody.indexOf('<b>講員</b>') !== -1);
  assert.strictEqual(env.sandbox.readSheet('SendLog')[0].DRY_RUN, false);
  assertWrittenChinese(assert, '通知內容', [mail.subject, mail.body]);
});

test('通知內容裡的使用者文字會跳脫（講題含標籤字元不會變成 HTML）', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, config: { DRY_RUN: 'FALSE' } });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ title: '<script>alert(1)</script>' }));
  const html = env.mail.calls[0].htmlBody;
  assert.strictEqual(html.indexOf('<script>'), -1);
  assert.ok(html.indexOf('&lt;script&gt;') !== -1);
});

test('通知組別沒有任何收件人 → 不寄也不報錯，答案照樣處理', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, config: { SPEAKER_FORM_NOTIFY_GROUPS: 'NOBODY', DRY_RUN: 'FALSE' } });
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ title: '新' }));
  assert.strictEqual(result.result, 'APPLIED');
  assert.strictEqual(env.mail.calls.length, 0);
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 0);
});

test('通知寄不出（MailApp 拋錯）→ 記 FAILED 到 SendLog，答案照樣已寫入', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, config: { DRY_RUN: 'FALSE' } });
  env.mail.sendEmail = function () { throw new Error('配額用完'); };
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ title: '新' }));
  assert.strictEqual(result.result, 'APPLIED');
  assert.strictEqual(weekRowOf(env, D).SERMON_TITLE, '新');
  assert.strictEqual(env.sandbox.readSheet('SendLog')[0].STATUS, 'FAILED');
});

// =====================================================================
// 4. 講員核對警告（真入口：週報資料模型／填寫介面載入）
// =====================================================================

console.log('\n講員核對警告');

function mismatchWarnings(env, iso) {
  return plain(env.sandbox.buildBulletinModel_(iso || D).warnings.filter(function (w) { return w.code === 'SPEAKER_FORM_MISMATCH'; }));
}

test('沒有任何表格答案 → 沒有警告（還沒有人用講員表格不是問題）', function () {
  assert.strictEqual(mismatchWarnings(makeEnv()).length, 0);
});

test('講員與事奉框不同 → 警告照指定字眼；一樣（去尊稱、空白後）→ 沒有警告', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, preacher: '甲牧師' });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '乙 傳道' }));
  const w = mismatchWarnings(env);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].message, '講員表格填的講員是「乙 傳道」，事奉框是「甲牧師」。如果真的換了講員，請在事奉框改「講員」；職事表要另外更正。');

  const env2 = makeEnv({ week: { SERMON_TITLE: '舊' }, preacher: '甲牧師' });
  env2.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: ' 甲  牧師 ' }));
  assert.strictEqual(mismatchWarnings(env2).length, 0);
  const env3 = makeEnv({ week: { SERMON_TITLE: '舊' }, preacher: '甲牧師' });
  env3.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '甲弟兄' }));
  assert.strictEqual(mismatchWarnings(env3).length, 0, '尊稱不同但名字一樣');
});

test('警告出現在填寫介面頂部的警告清單（apiLoadWeek）', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, preacher: '甲牧師' });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '乙傳道' }));
  const loaded = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
  assert.ok(plain(loaded.data.warnings).some(function (w) { return w.code === 'SPEAKER_FORM_MISMATCH'; }));
});

test('幹事在事奉框把講員改成表格那一位（DutyOverride）→ 警告消失（比的是套用覆寫之後的事奉框）', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, preacher: '甲牧師' });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '乙傳道' }));
  assert.strictEqual(mismatchWarnings(env).length, 1);
  const loaded = env.sandbox.loadWeekForWebApp_(D);
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: loaded.lastSavedAt, week: {}, baseWeek: {},
    payloadVersion: 2, dutyEdits: [{ postId: 'PREACHER', slotIndex: 1, name: '乙傳道' }]
  });
  assert.strictEqual(mismatchWarnings(env).length, 0);
});

test('警告也出現在星期一郵件（郵件內容用的是同一份 model.warnings）', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, preacher: '甲牧師' });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '乙傳道' }));
  const model = env.sandbox.buildBulletinModel_(D);
  const html = env.sandbox.buildBulletinEmailHtml_(model, {});
  assert.ok(html.indexOf('講員表格填的講員是') !== -1, '寄出的郵件要帶這個警告');
});

test('職事表沒有這個主日的資料時不出核對警告（整個事奉框都是空的，講員那一格不是重點）', function () {
  const env = makeEnv({ weekRows: [weekRowInput('2031-01-05', { SERMON_TITLE: '舊' })] });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ date: '2031-01-05' }));
  const model = env.sandbox.buildBulletinModel_('2031-01-05');
  assert.strictEqual(model.warnings.filter(function (w) { return w.code === 'SPEAKER_FORM_MISMATCH'; }).length, 0);
});

// =====================================================================
// 5. 處理答案——本季已有內容表
// =====================================================================

console.log('\n處理答案：本季已有內容表');

const TAB = '崇拜程序';

function makeContentEnv(options) {
  const o = options || {};
  const env = contentEnv.makeEnv(Object.assign({
    weekRows: [
      { SERVICE_DATE: '2027-10-03', QUARTER_ID: contentEnv.QUARTER_ID, SCRIPTURE_REF: '舊經文甲', SERMON_TITLE: '舊講題甲' },
      { SERVICE_DATE: '2027-10-10', QUARTER_ID: contentEnv.QUARTER_ID, SCRIPTURE_REF: '舊經文乙', SERMON_TITLE: '舊講題乙', PRELUDE: '序樂' }
    ],
    content: {
      崇拜程序: [
        { SERVICE_DATE: '2027-10-03', SCRIPTURE_REF: '舊經文甲', SERMON_TITLE: '舊講題甲', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-10', SCRIPTURE_REF: '舊經文乙', SERMON_TITLE: '舊講題乙', RESPONSE_HYMN: '回應詩乙', CHOIR_TITLE: '詩班乙', ACTIVE: 'TRUE' }
      ]
    }
  }, o));
  return env;
}

/** 讀出內容表「崇拜程序」分頁的資料列（機器鍵 → 值）。 */
function contentRows(env) {
  const keys = env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === TAB; })[0].keys;
  return plain(env.contentTabs[TAB].__data.slice(2).map(function (row) {
    const out = {};
    keys.forEach(function (k, i) { out[k] = row[i] === undefined ? '' : row[i]; });
    return out;
  }));
}

function contentSpeakerEvent(answer) {
  return speakerEvent(Object.assign({ date: '2027-10-10' }, answer || {}));
}

test('有內容表、該主日已有一行：只改那一行的兩格，其餘欄與其他主日一格不動；再用既有的匯入帶進週報', function () {
  const env = makeContentEnv();
  const result = env.sandbox.onSpeakerFormSubmit_(contentSpeakerEvent({ scripture: '羅馬書 8:28', title: '新講題乙' }));
  assert.strictEqual(result.result, 'APPLIED', JSON.stringify(result));

  const rows = contentRows(env);
  assert.strictEqual(rows.length, 2, '沒有新增行');
  const rowB = rows.filter(function (r) { return r.SERVICE_DATE === '2027-10-10'; })[0];
  assert.strictEqual(rowB.SCRIPTURE_REF, '羅馬書 8:28');
  assert.strictEqual(rowB.SERMON_TITLE, '新講題乙');
  assert.strictEqual(rowB.RESPONSE_HYMN, '回應詩乙', '回應詩歌一格不動');
  assert.strictEqual(rowB.CHOIR_TITLE, '詩班乙', '詩班曲名一格不動');
  const rowA = rows.filter(function (r) { return r.SERVICE_DATE === '2027-10-03'; })[0];
  assert.strictEqual(rowA.SERMON_TITLE, '舊講題甲', '其他主日不動');

  const week = contentWeekOf(env, '2027-10-10');
  assert.strictEqual(week.SCRIPTURE_REF, '羅馬書 8:28');
  assert.strictEqual(week.SERMON_TITLE, '新講題乙');
  assert.strictEqual(contentWeekOf(env, '2027-10-03').SERMON_TITLE, '舊講題甲', '匯入只限選定的主日');
  assert.strictEqual(week.PRELUDE, '序樂', '匯入只限「崇拜程序」分頁，不動其他欄');

  assert.deepStrictEqual(snapshotReasons(env, '2027-10-10'), ['SPEAKER_FORM'], '版本只存一個，匯入不另外存');
  assert.ok(result.detail.indexOf('已寫進內容表') !== -1 && result.detail.indexOf('並已匯入週報') !== -1, result.detail);
});

function contentWeekOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

test('D12 真正入口：講員表格答案（本季有內容表）拿鎖 → applyContentImport_() 是巢狀呼叫 → 用不可重入的鎖亦成功（以前內層要等滿 30 秒再 LOCK_TIMEOUT）；鎖只拿一次、只放一次、匯入時仍在外層手上', function () {
  const env = makeContentEnv();
  const events = [];
  let held = false;
  env.sandbox.LockService = {
    getScriptLock: function () {
      return {
        tryLock: function (ms) { events.push('tryLock:' + ms); if (held) return false; held = true; return true; },
        releaseLock: function () { events.push('releaseLock'); held = false; }
      };
    }
  };
  const sb = env.sandbox;
  const original = sb.writeContentImportPlan_;
  let heldDuringImport = null;
  sb.writeContentImportPlan_ = function () {
    heldDuringImport = held && sb.scriptLockHeldInThisExecution_();
    return original.apply(this, arguments);
  };
  const result = sb.onSpeakerFormSubmit_(contentSpeakerEvent({ scripture: '羅馬書 8:28', title: '新講題乙' }));
  sb.writeContentImportPlan_ = original;
  assert.strictEqual(result.result, 'APPLIED', JSON.stringify(result));
  assert.strictEqual(heldDuringImport, true, '匯入寫入時鎖仍在外層手上');
  assert.deepStrictEqual(events, ['tryLock:30000', 'releaseLock'], '只拿一次、只放一次');
  assert.strictEqual(contentWeekOf(env, '2027-10-10').SERMON_TITLE, '新講題乙');
  assert.strictEqual(sb.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'LOCK_TIMEOUT'; }).length, 0);
});

test('有內容表、該主日內容表還沒有那一行：在最後新增一行（日期、兩格、有效＝TRUE），再匯入', function () {
  const env = makeContentEnv({
    weekRows: [
      { SERVICE_DATE: '2027-10-03', QUARTER_ID: contentEnv.QUARTER_ID },
      { SERVICE_DATE: '2027-10-10', QUARTER_ID: contentEnv.QUARTER_ID }
    ],
    content: { 崇拜程序: [{ SERVICE_DATE: '2027-10-03', SCRIPTURE_REF: '甲', SERMON_TITLE: '甲講題', ACTIVE: 'TRUE' }] }
  });
  const result = env.sandbox.onSpeakerFormSubmit_(contentSpeakerEvent({ scripture: '3:16', title: '新增的一行' }));
  assert.strictEqual(result.result, 'APPLIED', JSON.stringify(result));
  const rows = contentRows(env);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].SERVICE_DATE, '2027-10-10');
  assert.strictEqual(rows[1].SCRIPTURE_REF, '3:16', '像時間的經文也原樣寫入');
  assert.strictEqual(rows[1].SERMON_TITLE, '新增的一行');
  assert.strictEqual(rows[1].ACTIVE, 'TRUE');
  assert.strictEqual(contentWeekOf(env, '2027-10-10').SERMON_TITLE, '新增的一行');
  assert.ok(contentWeekOf(env, '2027-10-10').SCRIPTURE_REF === '3:16');
  assert.ok(result.detail.indexOf('新增一行') !== -1, result.detail);
});

test('有內容表：同一個主日有多行生效中的資料時改最後一行（匯入也看最後一行）', function () {
  const env = makeContentEnv({
    weekRows: [{ SERVICE_DATE: '2027-10-10', QUARTER_ID: contentEnv.QUARTER_ID }],
    content: { 崇拜程序: [
      { SERVICE_DATE: '2027-10-10', SERMON_TITLE: '第一行', ACTIVE: 'TRUE' },
      { SERVICE_DATE: '2027-10-10', SERMON_TITLE: '第二行', ACTIVE: 'TRUE' }
    ] }
  });
  env.sandbox.onSpeakerFormSubmit_(contentSpeakerEvent({ title: '改最後一行' }));
  const rows = contentRows(env);
  assert.strictEqual(rows[0].SERMON_TITLE, '第一行');
  assert.strictEqual(rows[1].SERMON_TITLE, '改最後一行');
  assert.strictEqual(contentWeekOf(env, '2027-10-10').SERMON_TITLE, '改最後一行');
});

test('有內容表：內容表那一行已停用（有效＝FALSE）→ 不復活它，另起新行', function () {
  const env = makeContentEnv({
    weekRows: [{ SERVICE_DATE: '2027-10-10', QUARTER_ID: contentEnv.QUARTER_ID }],
    content: { 崇拜程序: [{ SERVICE_DATE: '2027-10-10', SERMON_TITLE: '停用的舊行', ACTIVE: 'FALSE' }] }
  });
  env.sandbox.onSpeakerFormSubmit_(contentSpeakerEvent({ title: '新行' }));
  const rows = contentRows(env);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].ACTIVE, 'FALSE');
  assert.strictEqual(rows[0].SERMON_TITLE, '停用的舊行');
  assert.strictEqual(rows[1].SERMON_TITLE, '新行');
});

test('有內容表而且那一格有人手覆寫 → 不寫內容表也不蓋週報，BLOCKED_BY_OVERRIDE', function () {
  const env = makeContentEnv();
  env.sandbox.writeSheet('FieldOverride', [{
    SERVICE_DATE: env.sandbox.normalizeDate_('2027-10-10'), FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '幹事改的',
    SOURCE_VALUE_AT_OVERRIDE: '舊講題乙', OVERRIDE_AT: new Date(), OVERRIDE_BY: 'x', REASON: '', ACTIVE: true, NOTES: ''
  }]);
  const result = env.sandbox.onSpeakerFormSubmit_(contentSpeakerEvent({ scripture: '舊經文乙', title: '講員填的講題' }));
  assert.strictEqual(result.result, 'BLOCKED_BY_OVERRIDE');
  assert.strictEqual(contentRows(env).filter(function (r) { return r.SERVICE_DATE === '2027-10-10'; })[0].SERMON_TITLE, '舊講題乙', '內容表那一格也不動');
  assert.strictEqual(snapshotReasons(env, '2027-10-10').length, 0, '什麼都沒寫，不存版本');
});

test('有內容表但開不到（檔案被刪）→ ERROR，不退而求其次寫 BulletinWeeks（否則下次匯入會被內容表蓋走）', function () {
  const env = makeContentEnv({ contentFileMissing: true });
  const result = env.sandbox.onSpeakerFormSubmit_(contentSpeakerEvent({ title: '新' }));
  assert.strictEqual(result.result, 'ERROR');
  assert.ok(result.detail.indexOf('內容表現在開不到') !== -1, result.detail);
  assert.strictEqual(contentWeekOf(env, '2027-10-10').SERMON_TITLE, '舊講題乙');
  assert.strictEqual(submissions(env)[0].result, 'ERROR');
  assert.ok(env.sandbox.readSheet('ErrorLog').some(function (r) { return r.FUNCTION_NAME === 'handleSpeakerFormSubmission_'; }));
});

test('匯入的分頁篩選：previewContentImport_ 的 tabNames 只處理選定的分頁，其他分頁一格都不動', function () {
  const env = makeContentEnv({
    content: {
      崇拜程序: [{ SERVICE_DATE: '2027-10-10', SERMON_TITLE: '新講題', ACTIVE: 'TRUE' }],
      宣召: [{ SERVICE_DATE: '2027-10-10', CALL_REF: '新出處', CALL_TEXT: '新經文', ACTIVE: 'TRUE' }]
    }
  });
  const only = env.sandbox.applyContentImport_(contentEnv.QUARTER_ID, { isoDate: '2027-10-10', tabNames: [TAB] });
  assert.strictEqual(only.ok, true, JSON.stringify(only));
  assert.strictEqual(contentWeekOf(env, '2027-10-10').SERMON_TITLE, '新講題');
  assert.strictEqual(contentWeekOf(env, '2027-10-10').CALL_REF || '', '', '「宣召」分頁不在篩選內，一格都不動');
  const all = env.sandbox.applyContentImport_(contentEnv.QUARTER_ID, { isoDate: '2027-10-10' });
  assert.strictEqual(contentWeekOf(env, '2027-10-10').CALL_REF, '新出處', '不篩選時照舊匯入全部分頁');
  assert.ok(all.ok);
});

// =====================================================================
// 6. 建立表格、刷新日期選項（真入口 api*）
// =====================================================================

console.log('\n建立表格與刷新日期選項');

function futureWeekRows() {
  return [weekRowInput(D, { SPECIAL_TYPE: '堂慶' }), weekRowInput(D_NEXT), weekRowInput('2020-01-05')];
}

test('apiCreateSpeakerForm：建立表單（只限教會帳戶、已驗證電郵）、搬進 Shared Drive 資料夾、寫 Config、裝一個觸發器', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  const resp = env.sandbox.apiCreateSpeakerForm();
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  assert.strictEqual(resp.data.triggerInstalled, true);
  assert.strictEqual(resp.data.warnings.length, 0);

  assert.strictEqual(env.forms.forms.length, 1);
  const form = env.forms.forms[0];
  assert.strictEqual(form.__settings.requireLogin, true, '只限教會帳戶登入');
  assert.strictEqual(form.__settings.emailCollectionType, 'VERIFIED', '收集已驗證電郵');
  assert.strictEqual(form.__settings.publishingSummary, false, '不公開別人的答案');
  assert.strictEqual(form.__title, '粵語堂主日講員資料');
  assert.ok(form.__settings.description.indexOf('只限教會帳戶') !== -1);
  assert.deepStrictEqual(plain(form.__items.map(function (i) { return [i.__type, i.__title, i.__required]; })), [
    ['LIST', '主日日期', true], ['TEXT', '講員', true], ['TEXT', '讀經經文', true], ['TEXT', '證道講題', true], ['PARAGRAPH_TEXT', '備註', false]
  ]);
  assert.deepStrictEqual(plain(form.__items[0].__choices), [D + '（堂慶）', D_NEXT], '日期選項：有特別主日附名稱，已過去的不列');

  const move = env.drive.calls.update[0];
  assert.strictEqual(move.id, form.__id);
  assert.strictEqual(move.args.addParents, SHARED_FOLDER);
  assert.strictEqual(move.args.supportsAllDrives, true);

  assert.strictEqual(env.sandbox.getConfig('SPEAKER_FORM_ID'), form.__id);
  assert.strictEqual(env.sandbox.getConfig('SPEAKER_FORM_URL'), form.getPublishedUrl());
  assert.strictEqual(env.triggers.installed.length, 1);
  assert.strictEqual(env.triggers.installed[0].getHandlerFunction(), 'onSpeakerFormSubmit_');
  assert.strictEqual(env.triggers.installed[0].getTriggerSourceId(), form.__id);
  assert.strictEqual(auditOf(env, 'SPEAKER_FORM_CREATE').length, 1);
});

test('資料夾預設用內容表的資料夾（SPEAKER_FORM_FOLDER_ID 留空時）', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { CONTENT_SHEET_FOLDER_ID: CONTENT_FOLDER } });
  const resp = env.sandbox.apiCreateSpeakerForm();
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  assert.strictEqual(env.drive.calls.update[0].args.addParents, CONTENT_FOLDER);
});

test('只建立一個長期使用的表格：已建立過就拒絕再建，連結不換', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  env.sandbox.apiCreateSpeakerForm();
  const again = env.sandbox.apiCreateSpeakerForm();
  assert.strictEqual(again.data.ok, false);
  assert.strictEqual(again.data.reason, 'ALREADY_EXISTS');
  assert.strictEqual(env.forms.forms.length, 1);
  assert.strictEqual(env.triggers.installed.length, 1, '不重複裝觸發器');
});

test('建立被拒絕的情況：沒有資料夾、不在 Shared Drive、查不到、沒有可選的主日——都不建立任何東西', function () {
  const noFolder = makeEnv({ weekRows: futureWeekRows() });
  const r1 = noFolder.sandbox.apiCreateSpeakerForm().data;
  assert.strictEqual(r1.reason, 'NO_FOLDER');
  assert.ok(r1.message.indexOf('SPEAKER_FORM_FOLDER_ID') !== -1 && r1.message.indexOf('CONTENT_SHEET_FOLDER_ID') !== -1, r1.message);

  const notShared = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: 'MY_DRIVE_FOLDER' } });
  assert.strictEqual(notShared.sandbox.apiCreateSpeakerForm().data.reason, 'NOT_SHARED_DRIVE');

  const cannotVerify = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER }, driveOptions: { failGet: true } });
  assert.strictEqual(cannotVerify.sandbox.apiCreateSpeakerForm().data.reason, 'CANNOT_VERIFY_FOLDER');

  const noDates = makeEnv({ weekRows: [weekRowInput('2020-01-05')], config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  assert.strictEqual(noDates.sandbox.apiCreateSpeakerForm().data.reason, 'NO_DATES');

  [noFolder, notShared, cannotVerify, noDates].forEach(function (e) {
    assert.strictEqual(e.forms.forms.length, 0, '被拒絕就不可以建出表單');
    assert.strictEqual(e.triggers.installed.length, 0);
    assert.strictEqual(e.sandbox.getConfig('SPEAKER_FORM_ID', ''), '');
  });
});

test('搬資料夾或裝觸發器失敗：表單已建立，ID 與連結照樣記下（免得再建第二個），警告講明要人手補做', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER }, driveOptions: { failUpdate: true } });
  const data = env.sandbox.apiCreateSpeakerForm().data;
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.warnings.length, 1);
  assert.ok(data.warnings[0].indexOf('搬進資料夾失敗') !== -1, data.warnings[0]);
  assert.strictEqual(env.sandbox.getConfig('SPEAKER_FORM_ID'), env.forms.forms[0].__id);
  assert.strictEqual(env.sandbox.apiCreateSpeakerForm().data.reason, 'ALREADY_EXISTS');
  assertWrittenChinese(assert, '建立警告', data.warnings);
});

test('FormApp 建立失敗（forms 範圍未授權）→ 整個呼叫回錯誤，Config 不留下假的表單 ID', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER }, formOptions: { failCreate: true } });
  const resp = env.sandbox.apiCreateSpeakerForm();
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(env.sandbox.getConfig('SPEAKER_FORM_ID', ''), '');
});

test('表單提交觸發器已經有了（例如人手裝過）→ 不重複安裝', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  env.triggers.installed.push({ getHandlerFunction: function () { return 'onSpeakerFormSubmit_'; } });
  const data = env.sandbox.apiCreateSpeakerForm().data;
  assert.strictEqual(data.triggerInstalled, false);
  assert.strictEqual(env.triggers.installed.length, 1);
});

test('apiRefreshSpeakerFormDates：日期選項換成最新一批；還沒建立表格 → NOT_CREATED', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  assert.strictEqual(env.sandbox.apiRefreshSpeakerFormDates().data.reason, 'NOT_CREATED');
  env.sandbox.apiCreateSpeakerForm();
  // 之後多了一個主日
  env.sandbox.writeSheet('BulletinWeeks', [weekRowInput('2027-11-21')]);
  const resp = env.sandbox.apiRefreshSpeakerFormDates();
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  assert.strictEqual(resp.data.count, 3);
  assert.deepStrictEqual(plain(env.forms.forms[0].__items[0].__choices), [D + '（堂慶）', D_NEXT, '2027-11-21']);
});

test('刷新時表格上找不到「主日日期」那一題 → 講明原因，不改動', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  env.sandbox.apiCreateSpeakerForm();
  env.forms.forms[0].__items[0].__title = '被改過的題目';
  const data = env.sandbox.apiRefreshSpeakerFormDates().data;
  assert.strictEqual(data.ok, false);
  assert.strictEqual(data.reason, 'NO_DATE_QUESTION');
  assert.ok(data.message.indexOf('主日日期') !== -1);
});

test('自動刷新（refreshSpeakerFormDatesQuietly_）：還沒建立表格就略過；失敗只記 ErrorLog、不拋錯', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  assert.deepStrictEqual(plain(env.sandbox.refreshSpeakerFormDatesQuietly_('測試')), { skipped: true, ok: true, message: '' });
  env.sandbox.apiCreateSpeakerForm();
  env.forms.setOption('failOpen', true);
  let result;
  assert.doesNotThrow(function () { result = env.sandbox.refreshSpeakerFormDatesQuietly_('測試'); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'SPEAKER_FORM_REFRESH_FAILED'; }).length, 1);
});

test('「建立本季空白週報」完成後自動刷新日期選項（有新增主日才刷新）', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  env.sandbox.apiCreateSpeakerForm();
  const choicesBefore = env.forms.forms[0].__items[0].__choices.slice();
  env.sandbox.writeSheet('BulletinWeeks', [weekRowInput('2027-11-21')]);
  env.sandbox.createBlankBulletinWeeks_(QUARTER_ID);
  assert.ok(env.forms.forms[0].__items[0].__choices.length >= choicesBefore.length + 1, '新增的主日要出現在下拉');
});

test('星期一觸發器內會自動刷新日期選項（接線；失敗不連累寄週報）', function () {
  const source = readSrc('src/Trigger.gs');
  assert.ok(source.indexOf("refreshSpeakerFormDatesQuietly_('weeklyBulletinSendTrigger_')") !== -1);
  assert.ok(source.indexOf("refreshSpeakerFormDatesQuietly_('weeklyBulletinSendTrigger_')") < source.indexOf('runQuarterRetention_({})'));
});

test('apiGetSpeakerFormStatus：未建立／已建立，連結與觸發器狀態（不用 FormApp）', function () {
  const env = makeEnv({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
  const before = env.sandbox.apiGetSpeakerFormStatus().data;
  assert.strictEqual(before.created, false);
  assert.strictEqual(before.folderConfigured, true);
  env.sandbox.apiCreateSpeakerForm();
  env.forms.setOption('failOpen', true); // 現況不應該靠 FormApp
  const after = env.sandbox.apiGetSpeakerFormStatus().data;
  assert.strictEqual(after.created, true);
  assert.strictEqual(after.url, env.forms.forms[0].getPublishedUrl());
  assert.strictEqual(after.editUrl, 'https://docs.google.com/forms/d/' + env.forms.forms[0].__id + '/edit');
  assert.strictEqual(after.triggerCount, 1);
  assert.strictEqual(after.triggerOk, true);
  assert.strictEqual(after.weeksAhead, 16);
});

// =====================================================================
// 7. 上線前檢查與完成度自我檢測
// =====================================================================

console.log('\n兩個檢測');

function checkEnvCreated(extra) {
  const env = makeEnv(Object.assign({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } }, extra || {}));
  env.sandbox.apiCreateSpeakerForm();
  return env;
}

test('尚未建立 → 兩個檢測都是 🟡 並講明下一步；建立好、設定齊全 → 🟢', function () {
  const none = makeEnv({ weekRows: futureWeekRows() });
  const S = none.sandbox.SELF_CHECK_STATUS_;
  assert.strictEqual(none.sandbox.selfCheckSpeakerFormItem_().status, S.YELLOW);
  const goLiveNone = none.sandbox.buildGoLiveChecklist_().filter(function (i) { return i.label === '上線前：講員表格'; })[0];
  assert.strictEqual(goLiveNone.status, S.YELLOW);
  assert.ok(goLiveNone.message.indexOf('建立講員表格') !== -1);

  const ok = checkEnvCreated();
  const item = ok.sandbox.selfCheckSpeakerFormItem_();
  assert.strictEqual(item.status, ok.sandbox.SELF_CHECK_STATUS_.GREEN, item.message);
  assert.strictEqual(item.label, '講員表格');
  const goLive = ok.sandbox.buildGoLiveChecklist_().filter(function (i) { return i.label === '上線前：講員表格'; })[0];
  assert.strictEqual(goLive.status, ok.sandbox.SELF_CHECK_STATUS_.GREEN, goLive.message);
  assert.strictEqual(goLive.message, item.message, '兩個檢測共用同一個判斷');
  assertWrittenChinese(assert, '檢測說明', [item.message, goLiveNone.message]);
});

test('🔴：沒有限教會帳戶、沒有收集已驗證電郵、觸發器不是剛好一個、資料夾不在 Shared Drive、表單開不到', function () {
  const S = makeEnv().sandbox.SELF_CHECK_STATUS_;

  const openLogin = checkEnvCreated();
  openLogin.forms.forms[0].__settings.requireLogin = false;
  const r1 = openLogin.sandbox.selfCheckSpeakerFormItem_();
  assert.strictEqual(r1.status, S.RED);
  assert.ok(r1.message.indexOf('沒有限制只有教會帳戶可以填') !== -1, r1.message);

  const noEmail = checkEnvCreated();
  noEmail.forms.forms[0].__settings.emailCollectionType = 'DO_NOT_COLLECT';
  assert.ok(noEmail.sandbox.selfCheckSpeakerFormItem_().message.indexOf('已驗證的電郵') !== -1);

  const noTrigger = checkEnvCreated();
  noTrigger.triggers.installed.length = 0;
  const r3 = noTrigger.sandbox.selfCheckSpeakerFormItem_();
  assert.strictEqual(r3.status, S.RED);
  assert.ok(r3.message.indexOf('沒有表單提交觸發器') !== -1);

  const twoTriggers = checkEnvCreated();
  twoTriggers.triggers.installed.push({ getHandlerFunction: function () { return 'onSpeakerFormSubmit_'; } });
  const r4 = twoTriggers.sandbox.selfCheckSpeakerFormItem_();
  assert.strictEqual(r4.status, S.RED);
  assert.ok(r4.message.indexOf('有 2 個表單提交觸發器') !== -1);

  const notShared = checkEnvCreated();
  notShared.sandbox.setConfig('SPEAKER_FORM_FOLDER_ID', 'MY_DRIVE_FOLDER', '測試');
  const r5 = notShared.sandbox.selfCheckSpeakerFormItem_();
  assert.strictEqual(r5.status, S.RED);
  assert.ok(r5.message.indexOf('不在 Shared Drive') !== -1);

  const gone = checkEnvCreated();
  gone.forms.setOption('failOpen', true);
  const r6 = gone.sandbox.selfCheckSpeakerFormItem_();
  assert.strictEqual(r6.status, S.RED);
  assert.ok(r6.message.indexOf('表格開不到') !== -1 && r6.message.indexOf('forms 範圍') !== -1, r6.message);
});

test('🟡：查不到（Drive 進階服務查詢失敗）不等於沒問題', function () {
  const env = checkEnvCreated();
  env.drive.calls.get.length = 0;
  const failing = makeAdvancedDrive({ failGet: true });
  env.sandbox.Drive = failing;
  const item = env.sandbox.selfCheckSpeakerFormItem_();
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.YELLOW, item.message);
  assert.ok(item.message.indexOf('「查不到」不等於「沒問題」') !== -1);
});

test('完成度自我檢測（真入口 runSelfCheck_）包含「講員表格」這一項', function () {
  const env = makeEnv({ weekRows: futureWeekRows() });
  const summary = env.sandbox.runSelfCheck_();
  assert.ok(plain(summary.items).some(function (i) { return i.label === '講員表格'; }));
});

// =====================================================================
// 8. 授權與靜態設定
// =====================================================================

console.log('\n授權與靜態設定');

test('appsscript.json 的 oauthScopes 有 forms 範圍', function () {
  const manifest = JSON.parse(readSrc('src/appsscript.json'));
  assert.ok(manifest.oauthScopes.indexOf('https://www.googleapis.com/auth/forms') !== -1);
});

test('FormApp 只出現在 SpeakerFormIo.gs；那個檔案不碰 DriveApp 也不引用職事表 ID（lint 規則 5）', function () {
  const { lint, FORM_APP_FILES } = require('../tools/lint-readonly-roster.js');
  assert.deepStrictEqual(FORM_APP_FILES, ['SpeakerFormIo.gs']);
  assert.deepStrictEqual(lint().violations, []);
  const ioCode = readSrc('src/SpeakerFormIo.gs').split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
  assert.strictEqual(ioCode.indexOf('DriveApp'), -1, '表單搬資料夾走 DriveShared.gs');
  const header = readSrc('tools/lint-readonly-roster.js').slice(0, 9000);
  assert.ok(header.indexOf('SpeakerFormIo.gs') !== -1 && header.indexOf('FormApp') !== -1, 'lint 檔頭要寫明原因');
});

test('講員表格所有 FormApp 行為集中在 SpeakerFormIo.gs，SpeakerForm.gs 不碰 FormApp／DriveApp／openById', function () {
  const logic = readSrc('src/SpeakerForm.gs');
  ['FormApp', 'DriveApp', 'openById(', 'ROSTER_SPREADSHEET_ID'].forEach(function (token) {
    const stripped = logic.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
    assert.strictEqual(stripped.indexOf(token), -1, 'SpeakerForm.gs 不可以出現 ' + token);
  });
});

// =====================================================================
// 9. 前端
// =====================================================================

console.log('\n前端');

function makeFakeDom() {
  const elements = {};
  function makeEl(tag) {
    const node = {
      tag: tag, textContent: '', attrs: {}, value: '', children: [], style: {},
      classes: new Set(), listeners: {},
      classList: {
        add: function (c) { node.classes.add(c); },
        remove: function (c) { node.classes.delete(c); },
        contains: function (c) { return node.classes.has(c); }
      },
      setAttribute: function (k, v) { node.attrs[k] = v; },
      removeAttribute: function (k) { delete node.attrs[k]; },
      appendChild: function (c) { node.children.push(c); return c; },
      select: function () {}
    };
    return node;
  }
  return {
    elements: elements, makeEl: makeEl,
    document: {
      getElementById: function (id) { if (!elements[id]) { elements[id] = makeEl('div'); elements[id].id = id; } return elements[id]; },
      createElement: function (tag) { return makeEl(tag); },
      body: { appendChild: function () {}, removeChild: function () {} },
      execCommand: function () { return false; }
    }
  };
}

function loadSpeakerRegion() {
  const js = readSrc('src/ui/Script.html');
  const start = js.indexOf('// BEGIN speaker-form');
  const end = js.indexOf('// END speaker-form');
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 speaker-form 區段標記');
  const dom = makeFakeDom();
  const ctx = { document: dom.document };
  vm.createContext(ctx);
  vm.runInContext(js.slice(start, end) + '\nthis.api = { model: speakerFormPanelModel, render: renderSpeakerFormPanel, createLines: buildSpeakerFormCreateDialogLines, copy: copyTextToClipboard };', ctx);
  return { api: ctx.api, dom: dom };
}

test('speakerFormPanelModel：未建立（有／沒有資料夾設定）、已建立（觸發器 0／1／多個／查不到）', function () {
  const t = loadSpeakerRegion();
  const base = { created: false, url: '', editUrl: '', triggerCount: 0, triggerOk: false, folderConfigured: true, weeksAhead: 16 };
  const none = t.api.model(base);
  assert.strictEqual(none.created, false);
  assert.ok(none.statusText.indexOf('還沒有建立講員表格') !== -1);
  assert.ok(t.api.model(Object.assign({}, base, { folderConfigured: false })).statusText.indexOf('SPEAKER_FORM_FOLDER_ID') !== -1);

  const made = Object.assign({}, base, { created: true, url: 'https://docs.google.com/forms/d/e/X/viewform', editUrl: 'https://docs.google.com/forms/d/X/edit', triggerCount: 1, triggerOk: true });
  const ok = t.api.model(made);
  assert.strictEqual(ok.fillUrl, made.url);
  assert.strictEqual(ok.editUrl, made.editUrl);
  assert.strictEqual(ok.triggerText, '觸發器：正常（剛好 1 個）。');
  assert.ok(ok.statusText.indexOf('16 個主日') !== -1);
  assert.ok(t.api.model(Object.assign({}, made, { triggerCount: 0, triggerOk: false })).triggerText.indexOf('沒有安裝') !== -1);
  assert.ok(t.api.model(Object.assign({}, made, { triggerCount: 3, triggerOk: false })).triggerText.indexOf('有 3 個') !== -1);
  assert.ok(t.api.model(Object.assign({}, made, { triggerCount: null, triggerOk: false })).triggerText.indexOf('查不到') !== -1);
  const evil = t.api.model(Object.assign({}, made, { url: 'javascript:alert(1)', editUrl: 'http://evil.example/' }));
  assert.strictEqual(evil.fillUrl, '', '網址不是 Google 表單就不畫成連結');
  assert.strictEqual(evil.editUrl, '');
});

test('renderSpeakerFormPanel：未建立只見「建立講員表格」；已建立見連結、複製、編輯、刷新；全部 textContent／href', function () {
  const t = loadSpeakerRegion();
  const els = t.dom.elements;
  t.api.render({ created: false, url: '', editUrl: '', triggerCount: 0, triggerOk: false, folderConfigured: true, weeksAhead: 16 });
  assert.strictEqual(els.speakerFormCreateBtn.classes.has('hidden'), false);
  assert.strictEqual(els.speakerFormCreated.classes.has('hidden'), true);

  t.api.render({ created: true, url: 'https://docs.google.com/forms/d/e/X/viewform', editUrl: 'https://docs.google.com/forms/d/X/edit', triggerCount: 1, triggerOk: true, folderConfigured: true, weeksAhead: 8 });
  assert.strictEqual(els.speakerFormCreateBtn.classes.has('hidden'), true);
  assert.strictEqual(els.speakerFormCreated.classes.has('hidden'), false);
  assert.strictEqual(els.speakerFormLink.attrs.href, 'https://docs.google.com/forms/d/e/X/viewform');
  assert.strictEqual(els.speakerFormEditLink.attrs.href, 'https://docs.google.com/forms/d/X/edit');
  assert.strictEqual(els.speakerFormLink.classes.has('hidden'), false);
  assert.strictEqual(els.speakerFormCopyBtn.classes.has('hidden'), false);
  assert.strictEqual(els.speakerFormTrigger.textContent, '觸發器：正常（剛好 1 個）。');
  assert.ok(els.speakerFormStatus.textContent.indexOf('8 個主日') !== -1);
});

test('copyTextToClipboard：先用 navigator.clipboard；被擋才退回 execCommand；兩個都失敗回 false', function () {
  const t = loadSpeakerRegion();
  const results = [];
  const resolved = { then: function (ok) { ok(); } };
  t.api.copy('連結', { clipboard: { writeText: function (text) { results.push('clip:' + text); return resolved; } } }, t.dom.document, function (ok) { results.push(ok); });
  assert.deepStrictEqual(results, ['clip:連結', true]);

  const blocked = { then: function (ok, bad) { bad(); } };
  const doc = Object.assign({}, t.dom.document, { execCommand: function () { return true; } });
  const r2 = [];
  t.api.copy('連結', { clipboard: { writeText: function () { return blocked; } } }, doc, function (ok) { r2.push(ok); });
  assert.deepStrictEqual(r2, [true]);

  const r3 = [];
  t.api.copy('連結', null, t.dom.document, function (ok) { r3.push(ok); });
  assert.deepStrictEqual(r3, [false]);
});

test('建立確認對話框的內容：四件事加授權提醒，書面語', function () {
  const t = loadSpeakerRegion();
  const lines = Array.from(t.api.createLines());
  assert.ok(lines.length >= 5);
  assert.ok(lines.join('\n').indexOf('只有教會帳戶登入才可以填') !== -1);
  assert.ok(lines.join('\n').indexOf('只作核對，不會改事奉框') !== -1);
  assert.ok(lines.join('\n').indexOf('重新授權') !== -1);
  assertWrittenChinese(assert, '建立講員表格對話框', lines);
});

test('接線：Index.html 有講員表格區塊（在季度作業之後、發佈及匯出之前）；建立走 openConfirmDialog；載入時取現況', function () {
  const html = readSrc('src/ui/Index.html');
  const js = readSrc('src/ui/Script.html');
  ['speakerFormPanel', 'speakerFormStatus', 'speakerFormCreateBtn', 'speakerFormCreated', 'speakerFormLink', 'speakerFormCopyBtn',
    'speakerFormEditLink', 'speakerFormRefreshBtn', 'speakerFormTrigger'].forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, 'Index.html 缺少 ' + id);
  });
  assert.ok(html.indexOf('id="speakerFormPanel"') > html.indexOf('quarter-ops-panel'));
  assert.ok(html.indexOf('id="speakerFormPanel"') < html.indexOf('publish-panel'));
  assert.ok(html.indexOf('建立講員表格') !== -1 && html.indexOf('複製填寫連結') !== -1 && html.indexOf('開啟表格（編輯）') !== -1 && html.indexOf('刷新日期選項') !== -1);

  const create = js.slice(js.indexOf('function onSpeakerFormCreateClicked('), js.indexOf('function onSpeakerFormRefreshClicked('));
  assert.ok(create.indexOf("openConfirmDialog('建立講員表格'") !== -1);
  assert.ok(create.indexOf("callServer('apiCreateSpeakerForm'") !== -1);
  assert.ok(js.indexOf("callServer('apiGetSpeakerFormStatus'") !== -1);
  const init = js.slice(js.indexOf('function init()'), js.indexOf('function onWeeksLoaded('));
  assert.ok(init.indexOf('loadSpeakerFormStatus()') !== -1);
  ['speakerFormCreateBtn', 'speakerFormRefreshBtn', 'speakerFormCopyBtn'].forEach(function (id) {
    assert.ok(js.indexOf("document.getElementById('" + id + "').addEventListener('click'") !== -1, id + ' 沒有綁事件');
  });
  assert.strictEqual(js.indexOf('window.confirm'), -1);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
