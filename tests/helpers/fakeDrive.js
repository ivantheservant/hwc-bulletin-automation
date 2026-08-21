#!/usr/bin/env node
/**
 * tests/helpers/fakeDrive.js
 *
 * 假的 `DriveApp` 與 `Utilities`（zip／unzip／newBlob）替身，供
 * tests/docxio.test.js 與 tests/bulletinrender.test.js 使用。
 *
 * ⚠️ 這裡的 blob 是**純 JavaScript 物件**，不是真的二進位資料——本專案
 * 的 `.docx` 處理只需要「entry 名稱 → 文字內容」這個層次，所以假替身把
 * zip 模型成一個陣列就夠了。真正要驗證的是**邏輯**：
 *   - 有沒有只改 `word/document.xml`
 *   - 其餘 entry 的內容有沒有被動過（用 `__text` 逐個比對）
 *   - 同名輸出檔有沒有加序號而不是覆蓋
 * 這些用假替身全部測得到，而且不需要任何真的 .docx 檔案。
 */

'use strict';

/**
 * 用途：造一個假 blob。
 * Args:
 *   text {string} 內容。
 *   name {string} 名稱。
 *   contentType {string=} MIME 類型。
 * Returns:
 *   {Object} 帶 `getName`／`setName`／`getDataAsString`／`getContentType`／
 *     `setContentType` 的假 blob；`__text` 是原始內容，方便測試直接比對。
 */
function makeFakeBlob(text, name, contentType) {
  return {
    __text: text,
    __name: name,
    __contentType: contentType || 'application/octet-stream',
    getName: function () { return this.__name; },
    setName: function (n) { this.__name = n; return this; },
    getDataAsString: function () { return this.__text; },
    getContentType: function () { return this.__contentType; },
    setContentType: function (t) { this.__contentType = t; return this; },
    getBytes: function () { return this.__text; }
  };
}

/**
 * 用途：造一份假的 `.docx`——一個 blob，內含完整的 zip entry 清單。
 *
 *   刻意包含 `word/media/image1.png`、`word/styles.xml`、`word/theme/theme1.xml`
 *   等等，因為測試最重要的斷言之一就是「這些檔案一個位元都沒有被動過」。
 * Args:
 *   documentXml {string} `word/document.xml` 的內容。
 *   options {{omitContentTypes:boolean=, documentEntryName:string=}=} 選填。
 *     `omitContentTypes` 用來測「缺少 [Content_Types].xml 要拋錯」；
 *     `documentEntryName` 用來測「entry 名稱大小寫／前綴有差異也要找得到」。
 * Returns:
 *   {Object} 假的 `.docx` blob，`__entries` 是 entry 清單。
 */
function buildFakeDocx(documentXml, options) {
  const opts = options || {};
  const entries = [];

  if (!opts.omitContentTypes) {
    entries.push(makeFakeBlob('<Types/>', '[Content_Types].xml'));
  }
  entries.push(makeFakeBlob('<Relationships/>', '_rels/.rels'));
  entries.push(makeFakeBlob(documentXml, opts.documentEntryName || 'word/document.xml'));
  entries.push(makeFakeBlob('<w:styles/>', 'word/styles.xml'));
  entries.push(makeFakeBlob('<w:settings/>', 'word/settings.xml'));
  entries.push(makeFakeBlob('<w:fonts/>', 'word/fontTable.xml'));
  entries.push(makeFakeBlob('THEME-BINARY', 'word/theme/theme1.xml'));
  entries.push(makeFakeBlob('PNG-BINARY-DATA', 'word/media/image1.png'));
  entries.push(makeFakeBlob('JPEG-BINARY-DATA', 'word/media/image2.jpeg'));

  const blob = makeFakeBlob('FAKE-DOCX-ZIP', 'template.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  blob.__entries = entries;
  return blob;
}

/**
 * 用途：造一個假的 `Utilities`，只實作 `unzip`／`zip`／`newBlob`／
 *   `formatDate` 四個本專案用得到的方法。
 * Args:
 *   options {{failUnzip:boolean=}=} 選填，`failUnzip` 用來測解壓失敗的分支。
 * Returns:
 *   {Object}
 */
function makeFakeUtilities(options) {
  const opts = options || {};
  return {
    unzip: function (blob) {
      if (opts.failUnzip) throw new Error('假的解壓失敗');
      if (!blob || !blob.__entries) throw new Error('這個 blob 不是一個 zip');
      // 回傳**同一批物件**，這樣測試可以用 identity 驗證「有沒有被換掉」。
      return blob.__entries;
    },
    zip: function (blobs, filename) {
      const zipped = makeFakeBlob('FAKE-DOCX-ZIP', filename, 'application/zip');
      zipped.__entries = blobs.slice();
      return zipped;
    },
    newBlob: function (content, contentType, name) {
      return makeFakeBlob(content, name, contentType);
    },
    formatDate: function () { return '2027-11-07 09:00'; }
  };
}

/**
 * 用途：造一個假的 `DriveApp`。
 * Args:
 *   options {{files:Object<string,Object>=, folders:Object<string,Object>=}=}
 *     `files` 是「檔案 ID → blob」；`folders` 是「資料夾 ID → 任意物件」
 *     （內容不重要，存在與否才重要）。
 * Returns:
 *   {{DriveApp:Object, listFolderFiles:function(string):Object[],
 *     createdFiles:Object[]}}
 *     `listFolderFiles(folderId)` 讓測試查某個資料夾建了哪些檔案。
 */
function makeFakeDriveApp(options) {
  const opts = options || {};
  const files = opts.files || {};
  const folders = opts.folders || {};
  const createdByFolder = {};
  const createdFiles = [];

  function makeFileHandle(id, blob) {
    return {
      getId: function () { return id; },
      getBlob: function () { return blob; },
      getName: function () { return blob.getName(); },
      getUrl: function () { return 'https://drive.example.invalid/file/d/' + id + '/view'; }
    };
  }

  function makeFolderHandle(folderId) {
    if (!createdByFolder[folderId]) createdByFolder[folderId] = [];
    return {
      getId: function () { return folderId; },
      getFilesByName: function (name) {
        const matches = createdByFolder[folderId].filter(function (f) { return f.name === name; });
        let i = 0;
        return {
          hasNext: function () { return i < matches.length; },
          next: function () { return makeFileHandle(matches[i].id, matches[i++].blob); }
        };
      },
      createFile: function (blob) {
        const id = 'CREATED_' + folderId + '_' + (createdByFolder[folderId].length + 1);
        const record = { id: id, name: blob.getName(), blob: blob, folderId: folderId };
        createdByFolder[folderId].push(record);
        createdFiles.push(record);
        return makeFileHandle(id, blob);
      }
    };
  }

  return {
    DriveApp: {
      getFileById: function (id) {
        if (!Object.prototype.hasOwnProperty.call(files, id)) {
          throw new Error('找不到檔案：' + id);
        }
        return makeFileHandle(id, files[id]);
      },
      getFolderById: function (id) {
        if (!Object.prototype.hasOwnProperty.call(folders, id)) {
          throw new Error('找不到資料夾：' + id);
        }
        return makeFolderHandle(id);
      }
    },
    listFolderFiles: function (folderId) { return (createdByFolder[folderId] || []).slice(); },
    createdFiles: createdFiles
  };
}

module.exports = {
  makeFakeBlob: makeFakeBlob,
  buildFakeDocx: buildFakeDocx,
  makeFakeUtilities: makeFakeUtilities,
  makeFakeDriveApp: makeFakeDriveApp
};
