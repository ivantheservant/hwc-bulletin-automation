#!/usr/bin/env node
/**
 * tests/helpers/wordEnv.js
 *
 * 能真的產生 Word 的完整測試環境：假 Drive（含進階服務）、假範本、輸出資料夾，
 * 加上 `makeFillEnv()` 的整套假試算表。原本寫在 tests/stage1.test.js 裏面，
 * 階段 2 的測試（產生 Word 之後存版本）也要用，所以抽成共用工具。
 */

'use strict';

const { makeFillEnv, QUARTER_ID } = require('./fillEnv');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./fakeDrive');
const fx = require('../fixtures/docxXml');

const D = '2027-11-07';
const D_NEXT = '2027-11-14';

const TEMPLATE_ID = 'FAKE_TEMPLATE_ID_NORMAL';
const OUTPUT_FOLDER = 'FAKE_OUTPUT_FOLDER';

/**
 * 造一個能真的產生 Word 的環境：假 Drive（含進階服務）、假範本、輸出資料夾。
 * Args:
 *   o {{config:Object=, driveOptions:Object=, uiAlerts:Object[]=, noFolder:boolean=,
 *      weekRows:Object[]=, weekTitles:Object=, combinedServices:Object=, noCombinedColumns:boolean=}=}
 */
function makeWordEnv(o) {
  const opts = o || {};
  const drive = makeFakeDriveApp(Object.assign({
    files: { [TEMPLATE_ID]: buildFakeDocx(fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')))) },
    folders: { [OUTPUT_FOLDER]: {} }
  }, opts.driveOptions || {}));
  const alerts = opts.uiAlerts || [];
  const utilities = makeFakeUtilities();
  utilities.base64Encode = function (bytes) { return 'B64:' + String(bytes).length; };
  const env = makeFillEnv({
    withGrid: false,
    emailTemplates: opts.emailTemplates,
    weekTitles: opts.weekTitles,
    combinedServices: opts.combinedServices,
    noCombinedColumns: opts.noCombinedColumns,
    weekRows: opts.weekRows || [
      { SERVICE_DATE: D, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '講題一' },
      { SERVICE_DATE: D_NEXT, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 2, STATUS: 'DRAFT', SERMON_TITLE: '講題二' }
    ],
    config: Object.assign({
      TEMPLATE_FILE_ID_NORMAL: TEMPLATE_ID,
      BULLETIN_OUTPUT_FOLDER_ID: opts.noFolder ? '' : OUTPUT_FOLDER
    }, opts.config || {}),
    driveApp: drive.DriveApp,
    driveAdvanced: drive.Drive,
    utilitiesZip: utilities,
    ui: {
      prompt: function () {
        return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return D; } };
      },
      alert: function (title, body) { alerts.push({ title: title, body: body }); return 'OK'; }
    }
  });
  return { sandbox: env.sandbox, drive: drive, alerts: alerts, sheets: env.sheets, mail: env.mail };
}

function weekRowOf(env, iso) {
  return env.sandbox.readSheet_('BulletinWeeks').filter(function (r) {
    return env.sandbox.formatIsoDate_(env.sandbox.normalizeDate_(r.SERVICE_DATE)) === iso;
  })[0];
}

module.exports = {
  makeWordEnv: makeWordEnv,
  weekRowOf: weekRowOf,
  TEMPLATE_ID: TEMPLATE_ID,
  OUTPUT_FOLDER: OUTPUT_FOLDER
};
