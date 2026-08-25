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
 *     `setContentType`／`copyBlob` 的假 blob；`__text` 是原始內容，方便
 *     測試直接比對。
 */
function makeFakeBlob(text, name, contentType) {
  const blob = {
    __text: text,
    __name: name,
    __contentType: contentType || 'application/octet-stream',
    getName: function () { return this.__name; },
    setName: function (n) { this.__name = n; return this; },
    getDataAsString: function () { return this.__text; },
    getContentType: function () { return this.__contentType; },
    setContentType: function (t) { this.__contentType = t; return this; },
    getBytes: function () { return this.__text; },
    // 模仿真實 Blob.copyBlob()：內容與名稱／內容類型都複製一份**獨立**
    // 的物件，改動複製品不會動到原本那個——`unzipDocx_()` 要先複製一份
    // 再改內容類型才呼叫 Utilities.unzip()，這裡的假替身要能撐住這個
    // 用法。`__entries`（`buildFakeDocx()` 造出來的頂層 blob才有）要一併
    // 帶過去，否則複製品會變成「不是一個 zip」。
    copyBlob: function () {
      const copy = makeFakeBlob(this.__text, this.__name, this.__contentType);
      if (this.__entries) copy.__entries = this.__entries;
      return copy;
    }
  };
  return blob;
}

/**
 * 用途：造一份假的 `.docx`——一個 blob，內含完整的 zip entry 清單。
 *
 *   刻意包含 `word/media/image1.png`、`word/styles.xml`、`word/theme/theme1.xml`
 *   等等，因為測試最重要的斷言之一就是「這些檔案一個位元都沒有被動過」。
 * Args:
 *   documentXml {string} `word/document.xml` 的內容。
 *   options {{omitContentTypes:boolean=, documentEntryName:string=,
 *            contentTypesIndex:number=, templateContentType:string=}=} 選填。
 *     `omitContentTypes` 用來測「缺少 [Content_Types].xml 要拋錯」；
 *     `documentEntryName` 用來測「entry 名稱大小寫／前綴有差異也要找得到」；
 *     `contentTypesIndex` 用來測 `moveContentTypesEntryFirst_()`——把
 *     `[Content_Types].xml` 放在指定位置而不是永遠第一個（模擬
 *     `Utilities.unzip()` 次序不保證的情況）；`templateContentType` 用來
 *     測 MIME 檢查（例如傳 Google 文件的 MIME，模擬範本被 Drive 自動
 *     轉換的情況）。
 * Returns:
 *   {Object} 假的 `.docx` blob，`__entries` 是 entry 清單。
 */
function buildFakeDocx(documentXml, options) {
  const opts = options || {};
  const entries = [];

  entries.push(makeFakeBlob('<Relationships/>', '_rels/.rels'));
  entries.push(makeFakeBlob(documentXml, opts.documentEntryName || 'word/document.xml'));
  entries.push(makeFakeBlob('<w:styles/>', 'word/styles.xml'));
  entries.push(makeFakeBlob('<w:settings/>', 'word/settings.xml'));
  entries.push(makeFakeBlob('<w:fonts/>', 'word/fontTable.xml'));
  entries.push(makeFakeBlob('THEME-BINARY', 'word/theme/theme1.xml'));
  entries.push(makeFakeBlob('PNG-BINARY-DATA', 'word/media/image1.png'));
  entries.push(makeFakeBlob('JPEG-BINARY-DATA', 'word/media/image2.jpeg'));

  if (!opts.omitContentTypes) {
    var insertAt = opts.contentTypesIndex === undefined ? 0 : opts.contentTypesIndex;
    entries.splice(insertAt, 0, makeFakeBlob('<Types/>', '[Content_Types].xml'));
  }

  const blob = makeFakeBlob('FAKE-DOCX-ZIP', 'template.docx',
    opts.templateContentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  blob.__entries = entries;
  return blob;
}

/**
 * 用途：造一個假的 `Utilities`，只實作 `unzip`／`zip`／`newBlob`／
 *   `formatDate` 四個本專案用得到的方法。
 *
 *   ⚠️ `unzip()` 刻意模仿真實 `Utilities.unzip()` 的行為：**只認內容
 *   類型是不是 `application/zip`**，跟傳進來的 blob 實際是不是一份
 *   合法的 zip 完全是兩回事——這樣才測得出「沒有先把內容類型改成
 *   `application/zip` 就直接呼叫」這個真實會遇到的事故（見
 *   docs/已知bug類型.md）。
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
      if (!blob || blob.getContentType() !== 'application/zip') {
        throw new Error('Invalid argument: ContentType. Should be of type: application/zip.');
      }
      if (!blob.__entries) throw new Error('這個 blob 不是一個 zip');
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
 *   options {{files:Object<string,Object>=, folders:Object<string,Object>=,
 *            rootAccessError:Error=}=}
 *     `files` 是「檔案 ID → blob」；`folders` 是「資料夾 ID → 任意物件」
 *     （內容不重要，存在與否才重要）；`rootAccessError` 選填，提供時
 *     `getRootFolder()` 會拋出這個例外（模擬 `probeDriveAccess_()` 授權
 *     不足的情況）。
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
      getName: function () { return 'FAKE_FOLDER_' + folderId; },
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
      getRootFolder: function () {
        if (opts.rootAccessError) throw opts.rootAccessError;
        return makeFolderHandle('ROOT');
      },
      getFolderById: function (id) {
        if (!Object.prototype.hasOwnProperty.call(folders, id)) {
          throw new Error('找不到資料夾：' + id);
        }
        return makeFolderHandle(id);
      }
    },
    // Drive **進階服務**的替身。`uniqueOutputFileName_()` 改走
    // `driveCountFilesByNameInFolder_()`（Shared Drive 一定要帶
    // `supportsAllDrives`），所以測試環境也要有這一個。
    Drive: {
      Files: {
        list: function (optionalArgs) {
          const args = optionalArgs || {};
          if (args.supportsAllDrives !== true) {
            throw new Error('Drive.Files.list：缺少 supportsAllDrives，Shared Drive 會回 File not found');
          }
          // 刻意用字串切割而不是正規表示式：查詢字串本身含有引號與
          // 跳脫字元，用正規表示式寫在測試替身裡只會多一個容易寫錯的地方。
          // ⚠️ **v3 的形狀**（appsscript.json 把進階服務釘死在 v3）。
          //    這個假替身本來模仿的是 v2（`title = '…'`、回 `{items}`），
          //    於是它與 src/ 那一邊**一齊錯**——測試全部綠，而真環境每一次
          //    呼叫都回「Invalid field selection items」。
          //    見 docs/已知bug類型.md 事故三十七。
          const q = String(args.q || '');
          const folderEnd = q.indexOf("' in parents");
          const nameKey = "name = '";
          const nameStart = q.indexOf(nameKey);
          if (q.indexOf("title = '") !== -1) {
            throw new Error("Drive.Files.list：查詢用了 v2 的 title，v3 應該用 name");
          }
          if (folderEnd === -1 || nameStart === -1) return { files: [] };

          const folderId = q.slice(q.indexOf("'") + 1, folderEnd);
          const afterName = q.slice(nameStart + nameKey.length);
          const wanted = afterName.slice(0, afterName.indexOf("'"));
          const found = (createdByFolder[folderId] || [])
            .filter(function (f) { return f.name === wanted; })
            .map(function (f) { return { id: f.id }; });
          return { files: found };
        },
        get: function (fileId, optionalArgs) {
          if (!optionalArgs || optionalArgs.supportsAllDrives !== true) {
            throw new Error('Drive.Files.get：缺少 supportsAllDrives');
          }
          if (!Object.prototype.hasOwnProperty.call(files, fileId)) {
            throw new Error('File not found: ' + fileId);
          }
          // v3 的檔名欄位是 `name`。
          return { id: fileId, name: files[fileId].getName() };
        }
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
