#!/usr/bin/env node
/**
 * tests/yearlogo.test.js
 *
 * 2026-11-02（Ivan）：Config `YEAR_LOGO_FILE_ID`——產生 Word 時把範本內替代文字 `YEAR_LOGO` 的年度 logo 換成雲端硬碟上
 * 的 JPG／PNG（src/YearLogo.gs 純函式、src/DocxIo.gs 讀檔與改 zip）。換不到不阻止產生，但結果有警告。
 *
 * 真正入口：generateBulletinDocx_（假 Drive、假範本）。
 *
 * 執行方式：node tests/yearlogo.test.js
 */

'use strict';

const assert = require('assert');
const { makeWordEnv } = require('./helpers/wordEnv');
const { buildFakeDocx, makeFakeBlob } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');
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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}

const IMAGE_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** 一個 `<w:drawing>`（浮動圖片），`descr` 是替代文字，`relId` 是圖片關係。框的大小與四個範本相同。 */
function drawing(descr, relId, id) {
  return '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" '
    + 'locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:extent cx="3033309" cy="1164921"/>'
    + '<wp:docPr id="' + id + '" name="Picture ' + id + '"' + (descr ? ' descr="' + descr + '"' : '') + '/>'
    + '<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="' + relId + '"/></pic:blipFill>'
    + '<pic:spPr><a:xfrm><a:ext cx="3033309" cy="1164921"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic>'
    + '</wp:anchor></w:drawing></w:r>';
}
function rels(list) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="x">'
    + list.map(function (r) { return '<Relationship Id="' + r[0] + '" Type="' + IMAGE_TYPE + '" Target="' + r[1] + '"/>'; }).join('')
    + '</Relationships>';
}
const TYPES_PNG_JPEG = '<?xml version="1.0"?><Types xmlns="t"><Default Extension="jpeg" ContentType="image/jpeg"/>'
  + '<Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/></Types>';

console.log('\n純函式（src/YearLogo.gs）');

test('YL-1 一張 YEAR_LOGO 圖、關係只有它用：改那一個關係的 Target，主文件與框不改，內容類型已有就不加', function () {
  const sb = makeWordEnv({}).sandbox;
  const doc = fx.documentXml(fx.para(drawing('YEAR_LOGO', 'rId9', 1)) + fx.para(drawing('', 'rId8', 2)));
  const out = sb.applyYearLogoToDocxParts_({
    documentXml: doc, relsXml: rels([['rId8', 'media/image1.png'], ['rId9', 'media/image2.jpeg']]),
    contentTypesXml: TYPES_PNG_JPEG, entryNames: ['word/media/image1.png', 'word/media/image2.jpeg'], contentType: 'image/png'
  });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.documentXml, doc, '主文件（包括 <wp:extent>）不改');
  assert.ok(out.relsXml.indexOf('<Relationship Id="rId9" Type="' + IMAGE_TYPE + '" Target="media/year_logo.png"/>') !== -1, out.relsXml);
  assert.ok(out.relsXml.indexOf('Target="media/image1.png"') !== -1, '其他圖不改');
  assert.strictEqual(out.contentTypesXml, TYPES_PNG_JPEG);
  assert.strictEqual(out.mediaPath, 'word/media/year_logo.png');
  assert.deepStrictEqual(Array.from(out.retargeted), ['rId9']);
  assert.strictEqual(out.drawingCount, 1);
});

test('YL-2 同一個關係 ID 亦被另一張（不是 YEAR_LOGO 的）圖用到：不改那一個關係，另加 rIdYearLogo1，只改 YEAR_LOGO 那張的 r:embed', function () {
  const sb = makeWordEnv({}).sandbox;
  const doc = fx.documentXml(fx.para(drawing('', 'rId9', 1)) + fx.para(drawing('YEAR_LOGO', 'rId9', 2)) + fx.para(drawing('YEAR_LOGO', 'rId9', 3)));
  const relsXml = rels([['rId9', 'media/image2.jpeg']]);
  const out = sb.applyYearLogoToDocxParts_({ documentXml: doc, relsXml: relsXml, contentTypesXml: TYPES_PNG_JPEG, entryNames: [],
    contentType: 'image/jpeg' });
  assert.strictEqual(out.ok, true, out.reason);
  assert.deepStrictEqual(Array.from(out.addedRelIds), ['rIdYearLogo1']);
  assert.ok(out.relsXml.indexOf('<Relationship Id="rId9" Type="' + IMAGE_TYPE + '" Target="media/image2.jpeg"/>') !== -1, '原本的關係不改');
  assert.ok(out.relsXml.indexOf('<Relationship Id="rIdYearLogo1" Type="' + IMAGE_TYPE + '" Target="media/year_logo.jpeg"/>') !== -1, out.relsXml);
  const embeds = (out.documentXml.match(/r:embed="[^"]+"/g) || []);
  assert.deepStrictEqual(embeds, ['r:embed="rId9"', 'r:embed="rIdYearLogo1"', 'r:embed="rIdYearLogo1"'], '只改兩張 YEAR_LOGO');
  assert.strictEqual(out.documentXml.replace(/rIdYearLogo1/g, 'rId9'), doc, '除 r:embed 以外一個字都不改');
  assert.strictEqual(out.mediaPath, 'word/media/year_logo.jpeg');
});

test('YL-3 內容類型沒有那個副檔名就補上（連 <Types/> 自閉合）；zip 內已有 year_logo.png 就改名 year_logo_2.png', function () {
  const sb = makeWordEnv({}).sandbox;
  const doc = fx.documentXml(fx.para(drawing('YEAR_LOGO', 'rId9', 1)));
  const a = sb.applyYearLogoToDocxParts_({ documentXml: doc, relsXml: rels([['rId9', 'media/image2.jpeg']]),
    contentTypesXml: '<Types xmlns="t"><Default Extension="jpeg" ContentType="image/jpeg"/></Types>',
    entryNames: ['word/media/year_logo.png'], contentType: 'image/png' });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.contentTypesXml, '<Types xmlns="t"><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
  assert.strictEqual(a.mediaPath, 'word/media/year_logo_2.png');
  const b = sb.applyYearLogoToDocxParts_({ documentXml: doc, relsXml: rels([['rId9', 'media/image2.jpeg']]), contentTypesXml: '<Types/>',
    entryNames: [], contentType: 'image/jpeg' });
  assert.strictEqual(b.contentTypesXml, '<Types><Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
});

test('YL-4 換不到的原因：不是 PNG／JPEG、範本沒有 YEAR_LOGO、圖沒有 r:embed、關係檔沒有那個 ID——三份 XML 一律原樣', function () {
  const sb = makeWordEnv({}).sandbox;
  const doc = fx.documentXml(fx.para(drawing('YEAR_LOGO', 'rId9', 1)));
  const base = { documentXml: doc, relsXml: rels([['rId9', 'media/image2.jpeg']]), contentTypesXml: TYPES_PNG_JPEG, entryNames: [] };
  function reason(extra) { const r = sb.applyYearLogoToDocxParts_(Object.assign({}, base, { contentType: 'image/png' }, extra)); return r.ok ? 'OK' : r.reason; }
  assert.strictEqual(reason({ contentType: 'image/gif' }), 'NOT_IMAGE');
  assert.strictEqual(reason({ documentXml: fx.documentXml(fx.para(drawing('公司 logo', 'rId9', 1))) }), 'NO_LOGO');
  assert.strictEqual(reason({ documentXml: doc.replace(' r:embed="rId9"', '') }), 'NO_EMBED');
  assert.strictEqual(reason({ relsXml: rels([['rId8', 'media/image1.png']]) }), 'REL_NOT_FOUND');
  const r = sb.applyYearLogoToDocxParts_(Object.assign({}, base, { contentType: 'image/gif' }));
  assert.strictEqual(r.documentXml, base.documentXml);
  assert.strictEqual(r.relsXml, base.relsXml);
  assert.strictEqual(r.contentTypesXml, base.contentTypesXml);
  assert.strictEqual(sb.yearLogoImageExtension_('IMAGE/JPEG'), 'jpeg');
  assert.strictEqual(sb.yearLogoImageExtension_('application/pdf'), '');
});

console.log('\nWord（真入口 generateBulletinDocx_）');

const D = '2027-11-07';
const TEMPLATE_RELS = rels([['rId8', 'media/image1.png'], ['rId9', 'media/image2.jpeg']]);
function logoTemplate(descr) {
  return buildFakeDocx(fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')) + fx.para(drawing(descr, 'rId9', 1)) + fx.para(drawing('', 'rId8', 2))),
    { relsXml: TEMPLATE_RELS, contentTypesXml: TYPES_PNG_JPEG });
}
function logoEnv(o) {
  const files = { FAKE_TEMPLATE_ID_NORMAL: logoTemplate(o.descr === undefined ? 'YEAR_LOGO' : o.descr) };
  Object.assign(files, o.files || {});
  return makeWordEnv({ config: { YEAR_LOGO_FILE_ID: o.logoId || '' }, driveOptions: { files: files } });
}
function entry(blob, name) {
  const hit = blob.__entries.filter(function (e) { return e.getName() === name; });
  return hit.length ? hit[0] : null;
}
function logoWarnings(r) {
  return JSON.parse(JSON.stringify((r.warnings || []).filter(function (w) { return String(w.code).indexOf('YEAR_LOGO_') === 0; })));
}

test('YL-5 Config 填了 PNG：zip 多了 word/media/year_logo.png（就是那張圖）、YEAR_LOGO 的關係改指新圖、框不變；其他 entry 一個位元不改；沒有警告', function () {
  const env = logoEnv({ logoId: 'LOGO_2027', files: { LOGO_2027: makeFakeBlob('PNG-LOGO-2027', '2027年度logo.png', 'image/png') } });
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(logoWarnings(r), []);
  const media = entry(r.blob, 'word/media/year_logo.png');
  assert.ok(media, '要有新圖：' + r.blob.__entries.map(function (e) { return e.getName(); }).join('、'));
  assert.strictEqual(media.__text, 'PNG-LOGO-2027');
  const relsOut = entry(r.blob, 'word/_rels/document.xml.rels').getDataAsString();
  assert.ok(relsOut.indexOf('<Relationship Id="rId9" Type="' + IMAGE_TYPE + '" Target="media/year_logo.png"/>') !== -1, relsOut);
  assert.ok(relsOut.indexOf('<Relationship Id="rId8" Type="' + IMAGE_TYPE + '" Target="media/image1.png"/>') !== -1);
  const doc = entry(r.blob, 'word/document.xml').getDataAsString();
  assert.strictEqual((doc.match(/<wp:extent cx="3033309" cy="1164921"\/>/g) || []).length, 2, '框不變');
  assert.ok(doc.indexOf('r:embed="rId9"') !== -1);
  assert.strictEqual(entry(r.blob, 'word/media/image2.jpeg').__text, 'JPEG-BINARY-DATA', '舊圖原樣留着');
  assert.strictEqual(entry(r.blob, 'word/styles.xml').__text, '<w:styles/>');
  assert.strictEqual(entry(r.blob, '[Content_Types].xml').getDataAsString(), TYPES_PNG_JPEG, '已有 png 就不加');
  assert.strictEqual(r.blob.__entries[0].getName(), '[Content_Types].xml', '內容類型仍然排第一');
  assert.strictEqual(r.residual.count, 0);
});

test('YL-6 Config 留空：與以前一樣只改主文件（關係檔、內容類型原物不動，沒有新圖、沒有警告）', function () {
  const env = logoEnv({});
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(logoWarnings(r), []);
  assert.strictEqual(entry(r.blob, 'word/media/year_logo.png'), null);
  assert.strictEqual(entry(r.blob, 'word/_rels/document.xml.rels').__text, TEMPLATE_RELS);
});

test('YL-7 Config 填了但檔案開不到 → 照樣產生（用範本的圖），警告 YEAR_LOGO_UNREADABLE，不印完整檔案 ID；對話框列出', function () {
  const env = logoEnv({ logoId: 'MISSING_LOGO_FILE_ID_123456' });
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const w = logoWarnings(r);
  assert.deepStrictEqual(w.map(function (x) { return x.code; }), ['YEAR_LOGO_UNREADABLE']);
  assert.strictEqual(w[0].message.indexOf('MISSING_LOGO_FILE_ID_123456'), -1, '不可以印完整 ID：' + w[0].message);
  assert.strictEqual(entry(r.blob, 'word/media/year_logo.png'), null);
  assert.strictEqual(entry(r.blob, 'word/_rels/document.xml.rels').__text, TEMPLATE_RELS);
  const lines = env.sandbox.buildGenerateResultDialogLines_(D, Object.assign({}, r, { file: { fileName: r.fileName, url: 'https://example.invalid/f' } }));
  assert.ok(lines.indexOf('⚠️ ' + w[0].message) !== -1, lines.join('\n'));
  assertWrittenChinese(assert, '年度 logo 警告', [w[0].message]);
});

test('YL-8 Config 填了一個 PDF → 警告 YEAR_LOGO_NOT_IMAGE（講明要 JPG 或 PNG），範本的圖不改', function () {
  const env = logoEnv({ logoId: 'LOGO_PDF', files: { LOGO_PDF: makeFakeBlob('%PDF', 'logo.pdf', 'application/pdf') } });
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const w = logoWarnings(r);
  assert.deepStrictEqual(w.map(function (x) { return x.code; }), ['YEAR_LOGO_NOT_IMAGE']);
  assert.ok(w[0].message.indexOf('application/pdf') !== -1 && w[0].message.indexOf('JPG 或 PNG') !== -1, w[0].message);
  assert.strictEqual(entry(r.blob, 'word/_rels/document.xml.rels').__text, TEMPLATE_RELS);
  assertWrittenChinese(assert, '年度 logo 警告', [w[0].message]);
});

test('YL-9 Config 填了 JPEG 但範本沒有 YEAR_LOGO 圖 → 警告 YEAR_LOGO_NOT_IN_TEMPLATE（講明範本名稱與怎樣補），一個 entry 都不改', function () {
  const env = logoEnv({ descr: '', logoId: 'LOGO_JPG', files: { LOGO_JPG: makeFakeBlob('JPEG-LOGO', 'logo.jpg', 'image/jpeg') } });
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const w = logoWarnings(r);
  assert.deepStrictEqual(w.map(function (x) { return x.code; }), ['YEAR_LOGO_NOT_IN_TEMPLATE']);
  assert.ok(w[0].message.indexOf('「' + r.templateLabel + '」範本') !== -1 && w[0].message.indexOf('YEAR_LOGO') !== -1, w[0].message);
  assert.strictEqual(entry(r.blob, 'word/media/year_logo.jpeg'), null);
  assert.strictEqual(entry(r.blob, 'word/_rels/document.xml.rels').__text, TEMPLATE_RELS);
  assert.strictEqual(entry(r.blob, '[Content_Types].xml').__text, TYPES_PNG_JPEG);
  assertWrittenChinese(assert, '年度 logo 警告', [w[0].message]);
});

test('YL-10 批次報告（generateQuarterBulletinsBatch_）每一期的結果亦列出年度 logo 警告', function () {
  const env = logoEnv({ logoId: 'LOGO_PDF', files: { LOGO_PDF: makeFakeBlob('%PDF', 'logo.pdf', 'application/pdf') } });
  const out = env.sandbox.generateQuarterBulletinsBatch_('2027T4');
  const ok = (out.results || []).filter(function (x) { return x.status === 'OK'; });
  assert.ok(ok.length > 0, JSON.stringify(out).slice(0, 400));
  ok.forEach(function (x) { assert.ok(x.message.indexOf('年度 logo：') !== -1, x.message); });
});

test('YL-11 Config 有 YEAR_LOGO_FILE_ID（預設空白，說明講明 JPG／PNG、框的大小與比例）', function () {
  const sb = makeWordEnv({}).sandbox;
  const entryDef = sb.DEFAULTS.filter(function (d) { return d.key === 'YEAR_LOGO_FILE_ID'; })[0];
  assert.ok(entryDef);
  assert.strictEqual(entryDef.value, '');
  assert.strictEqual(entryDef.note, '雲端硬碟上年度 logo 圖片（JPG／PNG）的檔案 ID；留空＝用範本內的圖。圖片會縮放到範本原本的框（8.43×3.24 cm，約 2.6:1），比例不同會變形，請先裁好。');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
