#!/usr/bin/env node
/**
 * tests/stage3.test.js
 *
 * 第二批階段 3：講員表格（Google Form）。內容表 v2（2026-10）起講員表格已停用——講員改在本季
 * 內容表「崇拜程序」填讀經經文與證道講題。這個檔案現在驗：
 *   - 停用之後每一個入口都不寫內容表、不寫週報（答案照記、照通知，不會憑空消失）；
 *   - 週報不再出講員核對警告；
 *   - 三個公開 api 回 SPEAKER_FORM_RETIRED，一次都不碰 FormApp；
 *   - 星期一觸發器與「建立本季空白週報」不再刷新表格的日期選項；
 *   - 純函式與兩個檢測（「季度工具 ▸ 停用舊功能」之前仍然看表格現況）保留，日後清理死碼時一併刪。
 *
 * 一律經真正入口：`onSpeakerFormSubmit_(e)`、`apiCreateSpeakerForm()` 等三個 api、
 * `weeklyBulletinSendTrigger_()`、`createBlankBulletinWeeks_()`、`buildBulletinModel_()`／`apiLoadWeek()`、
 * `runSelfCheck_()`／`buildGoLiveChecklist_()`。
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
// 內容表環境（講員表格停用之後亦不可以寫內容表；匯入的分頁篩選）
// =====================================================================

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

function contentWeekOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
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
// 2. 處理答案（真入口 onSpeakerFormSubmit_）——講員表格已停用
// =====================================================================

console.log('\n處理答案：講員表格已停用');

const RETIRED_LABEL = '講員表格已停用，沒有寫入';

test('沒有內容表：結果 RETIRED；BulletinWeeks 一格不動、不存版本；答案照記一行、AuditLog、通知', function () {
  const env = makeEnv({ week: { SCRIPTURE_REF: '舊經文', SERMON_TITLE: '舊講題', PRELUDE: '序樂不動' } });
  const weeksBefore = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ scripture: '羅馬書 8:28', title: '萬事互相效力', notes: '請預備投影' }));

  assert.strictEqual(result.result, 'RETIRED', JSON.stringify(result));
  assert.strictEqual(result.published, false);
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), weeksBefore, '週報一格都不可以寫');
  assert.strictEqual(snapshotReasons(env, D).length, 0, '沒有寫入就不存版本');

  const subs = submissions(env);
  assert.strictEqual(subs.length, 1, '答案不可以憑空消失');
  assert.strictEqual(subs[0].date, D);
  assert.strictEqual(subs[0].email, 'speaker@church.example');
  assert.strictEqual(subs[0].scripture, '羅馬書 8:28');
  assert.strictEqual(subs[0].title, '萬事互相效力');
  assert.strictEqual(subs[0].notes, '請預備投影');
  assert.strictEqual(subs[0].result, 'RETIRED');
  assert.ok(subs[0].detail.indexOf('「崇拜程序」') !== -1, '說明要講明改在哪裏填：' + subs[0].detail);
  assert.strictEqual(subs[0].active, true);

  const audit = auditOf(env, 'SPEAKER_FORM_SUBMIT');
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].NEW_VALUE, 'RETIRED');
  assert.strictEqual(auditOf(env, 'SPEAKER_FORM_WRITE').length, 0, '沒有逐格寫入記錄');

  const log = env.sandbox.readSheet('SendLog');
  assert.strictEqual(log.length, 1, '照 DRY_RUN 通知管理員（只寫 SendLog）');
  assert.ok(log[0].SUBJECT.indexOf(RETIRED_LABEL) !== -1, log[0].SUBJECT);
  assertWrittenChinese(assert, '停用說明', [subs[0].detail, env.sandbox.speakerFormResultLabel_('RETIRED')]);
});

test('有內容表：內容表「崇拜程序」與週報一格不動、不匯入；答案照記一行 RETIRED', function () {
  const env = makeContentEnv();
  const contentBefore = JSON.stringify(env.contentTabs[TAB].__data);
  const weeksBefore = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  const result = env.sandbox.onSpeakerFormSubmit_(contentSpeakerEvent({ scripture: '羅馬書 8:28', title: '新講題乙' }));
  assert.strictEqual(result.result, 'RETIRED', JSON.stringify(result));
  assert.strictEqual(JSON.stringify(env.contentTabs[TAB].__data), contentBefore, '內容表一格都不可以寫（講員表格不可以是第二個寫入入口）');
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), weeksBefore, '週報一格都不可以寫');
  assert.strictEqual(contentWeekOf(env, '2027-10-10').SERMON_TITLE, '舊講題乙');
  assert.strictEqual(snapshotReasons(env, '2027-10-10').length, 0);
  assert.strictEqual(submissions(env).length, 1);
  assert.strictEqual(submissions(env)[0].result, 'RETIRED');
});

test('題目字眼對不上、認不出主日日期：答案照樣記一行（RETIRED），不會憑空消失', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' } });
  const wrongTitles = makeFormSubmitEvent({ '主日日期': D, '講員': '甲牧師', '經文': 'x', '證道講題': 'y' });
  assert.strictEqual(env.sandbox.onSpeakerFormSubmit_(wrongTitles).result, 'RETIRED');
  assert.strictEqual(env.sandbox.onSpeakerFormSubmit_(speakerEvent({ date: '下個主日' })).result, 'RETIRED');
  const subs = submissions(env);
  assert.strictEqual(subs.length, 2);
  assert.strictEqual(subs[1].date, '', '認不出的日期記為空白');
  assert.strictEqual(weekRowOf(env, D).SERMON_TITLE, '舊');
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 2);
});

test('拿不到鎖 → 拋錯並記 ErrorLog，不處理這份答案', function () {
  const env = makeEnv();
  env.sandbox.LockService = { getScriptLock: function () { return { tryLock: function () { return false; }, releaseLock: function () {} }; } };
  assert.throws(function () { env.sandbox.onSpeakerFormSubmit_(speakerEvent()); }, /拿不到指令碼鎖/);
  assert.strictEqual(submissions(env).length, 0);
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'LOCK_TIMEOUT'; }).length, 1);
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

test('DRY_RUN=FALSE：寄給 ADMIN 組，內容有主日、講員、經文、講題，結果講明已停用、要改在內容表填', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, config: { DRY_RUN: 'FALSE' }, preacher: '甲牧師' });
  env.sandbox.onSpeakerFormSubmit_(speakerEvent({ speaker: '乙傳道', title: '新講題', notes: '備註內容' }));
  assert.strictEqual(env.mail.calls.length, 1);
  const mail = env.mail.calls[0];
  assert.strictEqual(mail.to, 'admin@x.com');
  assert.strictEqual(mail.subject, '假教會週報：講員表格新答案（' + D + '，' + RETIRED_LABEL + '）');
  ['主日：' + D, '答題者：speaker@church.example', '講員：乙傳道', '讀經經文：約翰福音 3:16', '證道講題：新講題', '備註：備註內容',
    '寫入結果：' + RETIRED_LABEL + '：', '「崇拜程序」', '填寫介面：https://example.invalid/webapp']
    .forEach(function (piece) { assert.ok(mail.body.indexOf(piece) !== -1, '通知內容缺少：' + piece + '\n' + mail.body); });
  assert.strictEqual(mail.body.indexOf('這一期已經發佈'), -1, '沒有寫入，不用提已發佈的 PDF');
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

test('通知組別沒有任何收件人 → 不寄也不報錯，答案照記', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, config: { SPEAKER_FORM_NOTIFY_GROUPS: 'NOBODY', DRY_RUN: 'FALSE' } });
  const result = env.sandbox.onSpeakerFormSubmit_(speakerEvent({ title: '新' }));
  assert.strictEqual(result.result, 'RETIRED');
  assert.strictEqual(env.mail.calls.length, 0);
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 0);
  assert.strictEqual(submissions(env).length, 1);
});

test('通知寄不出（MailApp 拋錯）→ SendLog 記 FAILED；通知整個失敗 → 只記 ErrorLog；兩種情況答案都照記', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, config: { DRY_RUN: 'FALSE' } });
  env.mail.sendEmail = function () { throw new Error('配額用完'); };
  assert.strictEqual(env.sandbox.onSpeakerFormSubmit_(speakerEvent({ title: '新' })).result, 'RETIRED');
  assert.strictEqual(env.sandbox.readSheet('SendLog')[0].STATUS, 'FAILED');
  assert.strictEqual(submissions(env).length, 1);

  const env2 = makeEnv({ week: { SERMON_TITLE: '舊' } });
  env2.sandbox.buildRecipientList_ = function () { throw new Error('收件人工作表壞了'); };
  assert.strictEqual(env2.sandbox.onSpeakerFormSubmit_(speakerEvent()).result, 'RETIRED');
  assert.strictEqual(submissions(env2).length, 1);
  const errs = env2.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'SPEAKER_FORM_NOTICE_FAILED'; });
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].MESSAGE.indexOf('答案已經記下') !== -1, errs[0].MESSAGE);
});

// =====================================================================
// 4. 講員核對警告已停用（真入口：週報資料模型／填寫介面載入／星期一郵件）
// =====================================================================

console.log('\n講員核對警告已停用');

/** 停用之前留下的一份已寫入答案（講員與事奉框不同）。 */
function seedOldAnswer(env, speaker) {
  env.sandbox.writeSheet('SpeakerFormSubmissions', [{
    TIMESTAMP: new Date(), SERVICE_DATE: env.sandbox.normalizeDate_(D), RESPONDENT_EMAIL: 'speaker@church.example',
    SPEAKER_NAME: speaker, SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '神愛世人', NOTES: '', RESULT: 'APPLIED', DETAIL: '', ACTIVE: true
  }]);
}

test('停用之前的舊答案講員與事奉框不同 → 週報資料模型、填寫介面警告清單、星期一郵件都不再出 SPEAKER_FORM_MISMATCH', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '舊' }, preacher: '甲牧師' });
  seedOldAnswer(env, '乙傳道');
  const model = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(model.warnings.filter(function (w) { return w.code === 'SPEAKER_FORM_MISMATCH'; }).length, 0);
  const loaded = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
  assert.strictEqual(plain(loaded.data.warnings).filter(function (w) { return w.code === 'SPEAKER_FORM_MISMATCH'; }).length, 0);
  const html = env.sandbox.buildBulletinEmailHtml_(model, {});
  assert.strictEqual(html.indexOf('講員表格填的講員是'), -1);
});

// =====================================================================
// 5. 已停用的入口：三個公開 api、星期一觸發器、建立本季空白週報
// =====================================================================

console.log('\n已停用的入口');

/**
 * 一個會記下每一次存取的 FormApp 替身：停用之後不可以有任何程式碼碰它。
 * Returns:
 *   {{FormApp:Object, touched:string[]}}
 */
function makeWatchedFormApp() {
  const touched = [];
  const FormApp = new Proxy({}, {
    get: function (target, key) {
      if (typeof key === 'symbol') return undefined;
      touched.push(String(key));
      return function () { throw new Error('停用之後不可以再呼叫 FormApp.' + String(key)); };
    }
  });
  return { FormApp: FormApp, touched: touched };
}

/** 已經建立過講員表格的環境（Config 有表格 ID 與連結），FormApp 換成會記錄存取的替身。 */
function makeCreatedEnv(extra) {
  const env = makeEnv(Object.assign({
    weekRows: [weekRowInput(D), weekRowInput(D_NEXT)],
    config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER, SPEAKER_FORM_ID: 'OLD_FORM', SPEAKER_FORM_URL: 'https://docs.google.com/forms/d/e/OLD_FORM/viewform' }
  }, extra || {}));
  const watched = makeWatchedFormApp();
  env.sandbox.FormApp = watched.FormApp;
  env.formTouched = watched.touched;
  return env;
}

test('apiCreateSpeakerForm／apiRefreshSpeakerFormDates／apiGetSpeakerFormStatus：回 SPEAKER_FORM_RETIRED，不碰 FormApp、不裝觸發器、Config 不變', function () {
  ['apiCreateSpeakerForm', 'apiRefreshSpeakerFormDates', 'apiGetSpeakerFormStatus'].forEach(function (fn) {
    [false, true].forEach(function (created) {
      const env = created ? makeCreatedEnv() : makeEnv({ weekRows: [weekRowInput(D)], config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } });
      if (!created) { const w = makeWatchedFormApp(); env.sandbox.FormApp = w.FormApp; env.formTouched = w.touched; }
      const configBefore = JSON.stringify(env.sandbox.readSheet('Config'));
      const resp = env.sandbox[fn]();
      const label = fn + (created ? '（已建立表格）' : '（未建立表格）');
      assert.strictEqual(resp.ok, false, label);
      assert.strictEqual(resp.error.code, 'SPEAKER_FORM_RETIRED', label);
      assert.strictEqual(resp.error.message, '講員表格已停用，請在本季內容表「崇拜程序」填寫讀經經文與證道講題。這個動作一格都沒有寫。');
      assert.deepStrictEqual(env.formTouched, [], label + '：不可以碰 FormApp');
      assert.strictEqual(env.triggers.installed.length, 0, label + '：不可以裝觸發器');
      assert.strictEqual(JSON.stringify(env.sandbox.readSheet('Config')), configBefore, label + '：Config 不可以變');
      assert.strictEqual(env.drive.calls.update.length, 0, label + '：不可以搬檔案');
    });
  });
});

test('星期一觸發器（weeklyBulletinSendTrigger_）：已建立表格也不刷新日期選項（一次都不碰 FormApp）', function () {
  const env = makeCreatedEnv();
  env.sandbox.autoCreateContentSheetsForUpcomingQuarters_ = function () { return { created: [], invited: [], skipped: [] }; };
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.deepStrictEqual(env.formTouched, []);
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'SPEAKER_FORM_REFRESH_FAILED'; }).length, 0);
});

test('「建立本季空白週報」（createBlankBulletinWeeks_）新增主日之後不刷新日期選項（一次都不碰 FormApp）', function () {
  const env = makeCreatedEnv({ weekRows: [weekRowInput(D)] });
  const before = env.sandbox.readSheet('BulletinWeeks').length;
  env.sandbox.createBlankBulletinWeeks_(QUARTER_ID);
  assert.ok(env.sandbox.readSheet('BulletinWeeks').length > before, '前提：這一次真的新增了主日');
  assert.deepStrictEqual(env.formTouched, []);
});

test('程式碼裏（註解以外）再沒有地方呼叫 refreshSpeakerFormDatesQuietly_（只剩定義本身）', function () {
  const dir = path.join(__dirname, '..', 'src');
  const callers = fs.readdirSync(dir).filter(function (f) { return /\.gs$/.test(f); }).filter(function (f) {
    const code = readSrc('src/' + f).split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
    return code.replace(/function refreshSpeakerFormDatesQuietly_\(/g, '').indexOf('refreshSpeakerFormDatesQuietly_(') !== -1;
  });
  assert.deepStrictEqual(callers, []);
});

console.log('\n匯入的分頁篩選');

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
// 7. 上線前檢查與完成度自我檢測
// =====================================================================

console.log('\n兩個檢測');

function futureWeekRows() {
  return [weekRowInput(D, { SPECIAL_TYPE: '堂慶' }), weekRowInput(D_NEXT), weekRowInput('2020-01-05')];
}

/**
 * 已建立表格的環境。公開的 apiCreateSpeakerForm() 已停用，這裏直接用建立邏輯造前提
 * （停用之前建立好的表格）；受測的是兩個檢測，經真入口。
 */
function checkEnvCreated(extra) {
  const env = makeEnv(Object.assign({ weekRows: futureWeekRows(), config: { SPEAKER_FORM_FOLDER_ID: SHARED_FOLDER } }, extra || {}));
  const made = env.sandbox.createSpeakerFormForWebApp_();
  assert.strictEqual(made.ok, true, JSON.stringify(made));
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

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
