#!/usr/bin/env node
/**
 * 第十八輪批次階段 D：**commit 之前**掃描敏感資料嘅關卡。
 *
 * 執行方式（唔需要裝任何嘢）：
 *   node tools/scan-staged-secrets.js
 *   node tools/scan-staged-secrets.js --json      （畀程式讀嘅輸出）
 *
 * 離開碼：0 ＝ 可以 commit（可能有提示）　1 ＝ **有高風險項目，拒絕 commit**
 *
 * ─────────────────────────────────────────────────────────────────────
 * 點解要有呢個檔案（同 tests/scan_sensitive.test.js 有咩分別）
 * ─────────────────────────────────────────────────────────────────────
 *
 * 呢個 repo 係 public，已經洩漏過兩次。原本嘅流程係 **push 之後**先由對話端
 * 掃描——即係發現嗰陣已經公開咗，攔唔到。關卡要搬到 commit 之前。
 *
 * | | `tests/scan_sensitive.test.js` | 本檔案 |
 * |---|---|---|
 * | 時機 | 事後（跑測試時） | **commit 之前** |
 * | 對象 | 全部已追蹤檔案 | **即將 commit 嘅內容（staged diff）** |
 * | 用途 | 回歸測試 | **關卡**：高風險就拒絕 commit |
 *
 * 兩者互補，唔係取代——測試檔仍然會捉「之前已經 commit 咗」嘅殘留。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 設計上最重要嘅一條規矩：**呢個檔案本身唔可以寫任何真實資料**
 * ─────────────────────────────────────────────────────────────────────
 *
 * 唔可以喺呢度寫死教會網域、真實姓名、真實 PersonID——噉樣做本身就係
 * 一次洩漏，而且係寫喺一個「保護洩漏」嘅檔案入面，最諷刺亦最危險。
 *
 * 所以全部規則都係**否定式**（deny by default）：列出**安全嘅**樣式，
 * 其餘一律當可疑。安全清單入面全部都係公開嘅保留網域或者本專案自訂嘅
 * 假資料慣例，冇一項係真實資料。
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const JSON_OUTPUT = process.argv.indexOf('--json') !== -1;

// =====================================================================
// 安全清單（全部都係公開／保留／本專案自訂嘅假資料慣例，冇真實資料）
// =====================================================================

/** RFC 2606 保留網域 ＋ 本專案既有嘅假網域慣例 ＋ 工具鏈嘅公開網域。 */
const SAFE_DOMAIN_PATTERNS = [
  /\.invalid$/i,       // RFC 2606：專門畀「唔存在嘅範例位址」
  /\.test$/i,          // RFC 2606
  /\.example$/i,       // RFC 2606
  /^example\.(com|org|net)$/i,
  /\.localhost$/i,
  /^localhost$/i,
  /^x\.com$/i,         // 本專案測試／範本一律用呢個假網域
  /^anthropic\.com$/i, // Co-Authored-By 用
  /^(www\.)?google\.com$/i,
  /^script\.google\.com$/i,
  /^docs\.google\.com$/i,
  /^drive\.google\.com$/i,
  // OOXML（.docx）嘅命名空間 URI。呢啲係國際標準寫死嘅字串，唔係一個
  // 真係連得到嘅網站，亦都完全冇可能係教會網域——第七輪嘅 Word 範本
  // 渲染一定會喺 XML 入面出現。
  /^schemas\.openxmlformats\.org$/i,
  /^schemas\.microsoft\.com$/i,
  /^purl\.org$/i,
  /^www\.w3\.org$/i,
  /^developers\.google\.com$/i,
  /^(www\.)?github\.com$/i,
  /^raw\.githubusercontent\.com$/i,
  /^schema\.org$/i,
  /^www\.w3\.org$/i,
];

/**
 * 本專案文件／測試一律用嘅虛構姓名。呢啲**唔係真人**，係刻意公開嘅
 * 假資料慣例（見 docs/系統範圍稽核.md 開頭嘅聲明）。
 */
const KNOWN_FICTIONAL_NAMES = new Set([
  '陳大文', '李小明', '王美美', '假甲', '假乙', '假丙', '假丁',
]);

/**
 * 崗位名稱／系統詞彙——公開資訊，唔係任何人嘅姓名。
 * 同 `tests/scan_sensitive.test.js` 嘅 `STRUCTURAL_STOPWORDS` 同一個用途。
 */
const STRUCTURAL_STOPWORDS = new Set([
  '主席', '讀經', '領詩', '司事', '司數', '司琴', '音響', '控制', '報告',
  '交通指揮', '當值堂委', '特殊主日', '個崗位', '堂慶合堂', '聖餐襄禮',
  '獻花', '翻譯', '講員', '堂委', '執事', '幹事', '義工', '教會', '崇拜',
  '合堂', '浸禮', '宣教', '主日', '季度', '版本', '職事',
  '白名單',  // .gitignore 策略詞彙，呢個 repo 到處都係
]);

/**
 * 常用詞噪音過濾——**降噪，唔係放行**。
 *
 * 姓氏表入面有一批字同時係中文高頻虛詞／構詞成分（何、方、連、程、
 * 白、高、紀、石、田、古……），行文一定會踩中。實測第一版掃 15 個檔案
 * 就出咗 80 項提示，其中 60% 係「任何」「方法」「連續型」「程式碼」
 * 呢類——噪音多到冇人會逐項睇，等於個提示白做。
 *
 * 兩條規則：
 *   1. `WORD_HEADS`：姓氏做**開頭**嘅常用詞（方法／連續／程式……）
 *   2. `WORD_TAILS`：姓氏做**第二個字**嘅常用詞（任何／流程／空白……）
 *      —— 呢類要睇匹配位置**前面嗰個字**先判斷得到
 *
 * ⚠️ 取捨：真人姓名如果啱啱好撞正呢啲組合（例如姓連名續、姓程名式），
 * 就會被靜靜咁濾走。呢一項本來就係 MEDIUM／唔擋 commit，本質上係
 * 「幫人肉眼掃描縮窄範圍」，唔係保證。真正嘅保證嚟自 `.gitignore`
 * 白名單制同 `tests/scan_sensitive.test.js` 嗰層。
 */
const WORD_HEADS = [
  '方法', '方式', '方向', '方便', '方面', '方案', '連續', '連結', '連同',
  '連帶', '程式', '程序', '紀錄', '紀律', '陳述', '高風', '高於', '高過',
  '白色', '石油', '田野', '古老', '江湖', '馬上', '曾經', '簡單', '簡化',
  '施加', '范圍', '藍色', '黃色', '范例', '范疇',
];
const WORD_TAILS = [
  '任何', '如何', '為何', '幾何', '奈何', '相連', '接連', '一連', '流程',
  '過程', '工程', '課程', '日程', '行程', '世紀', '年紀', '明白', '坦白',
  '表白', '空白', '自白', '提高', '最高', '升高', '身高', '加高', '對方',
  '雙方', '地方', '前方', '後方', '官方', '我方', '單方', '多方', '各方',
];

/**
 * 「呢個 P 開頭嘅字串只係格式示範」嘅前置詞。
 * 例如：`請輸入 PersonID（例如 P0001）` —— 呢個 `P0001` 唔係真人。
 */
const FORMAT_DEMO_MARKERS = ['例如', '例：', '如：', 'e.g.', 'eg.', '格式', '示範', '例子'];

// =====================================================================
// 取得 staged diff
// =====================================================================

/**
 * 讀取即將 commit 嘅內容（staged diff 入面**新增**嘅行）。
 * 只睇新增行（`+` 開頭）——刪除行唔會進入新嘅 commit 內容。
 * @returns {{file: string, line: number, text: string}[]}
 */
function readStagedAddedLines() {
  let diff;
  try {
    // ⚠️ `-c core.quotepath=false` **唔可以省**。
    //
    // git 預設會將非 ASCII 路徑用引號包住並轉成八進位跳脫，
    // 於是 `docs/系統範圍稽核.md` 嘅檔頭會變成
    // `+++ "b/docs/\347\263\261..."`——**個引號喺 `b/` 前面**，
    // 所以 `startsWith('+++ b/')` 唔會中。呢個 repo 幾乎全部
    // 文件都係中文檔名，中招範圍唔細。
    //
    // 實測後果：`docs/系統範圍稽核.md` 入面嘅 22 項提示全部被報成
    // 喺 `.gitignore` 嗰度，行號係 3428 呢類——`.gitignore` 得 80 行。
    // 即係話，如果嗰啲係高風險項目，人手去追嗰陣會撲空。
    diff = execSync('git -c core.quotepath=false diff --cached --unified=0 --no-color', {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    });
  } catch (err) {
    throw new Error('讀取 staged diff 失敗（是不是不在 git repo 裡面？）：' + err.message);
  }
  return parseStagedDiff(diff);
}

/**
 * 由 diff 文字抽出新增行——**純函式**，方便測試。
 *
 * 特登同 `readStagedAddedLines()` 分開：解析邏輯（尤其係下面
 * 「認唔到檔頭就爆」嗰段）要測得到，唔應該困喺一個要真 git repo
 * 先跑得到嘅函式入面。
 *
 * @param {string} diff `git diff --cached --unified=0` 嘅輸出
 * @returns {{file: string, line: number, text: string}[]}
 */
function parseStagedDiff(diff) {
  const lines = [];
  let currentFile = null;
  let currentLineNo = 0;

  diff.split('\n').forEach(function (raw) {
    if (raw.startsWith('+++ b/')) {
      currentFile = raw.slice(6).trim();
      return;
    }
    if (raw.startsWith('+++ /dev/null')) { currentFile = null; return; }

    // ⚠️ 認唔到嘅 `+++` 檔頭一定要即刻爆，唔可以靜靜咁沿用上一個檔名。
    //
    // 呢個同階段 A 嗰個 bug class 係同一種：一個「我唔知道」被當成
    // 一個有意義嘅值（上一個檔名），結果係**報告照出，但指去錯嘅檔案**。
    // 靜靜咁行落去嘅代價，係人手追查嗰陣去錯地方——比直接爆更差。
    if (raw.startsWith('+++')) {
      throw new Error(
        '認唔到 diff 檔頭，唔敢繼續掃描：\n  ' + raw + '\n\n'
        + '預期格式係 `+++ b/<路徑>` 或者 `+++ /dev/null`。\n'
        + '如果路徑被引號包住（`+++ "b/..."`），代表 `core.quotepath` '
        + '冇成功關掉——檢查上面嗰句 execSync。\n'
        + '⚠️ 唔可以「當佢係上一個檔案」繼續行：噉樣行號會報去錯嘅檔案，'
        + '高風險項目就會追唔到。'
      );
    }

    // @@ -a,b +c,d @@ —— 取新檔案嘅起始行號
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { currentLineNo = Number(hunk[1]); return; }

    if (!currentFile) return;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lines.push({ file: currentFile, line: currentLineNo, text: raw.slice(1) });
      currentLineNo++;
    }
  });

  return lines;
}

/** 目前 git author 嘅電郵——唔寫死，執行時讀。 */
function readGitAuthorEmail() {
  try {
    return execSync('git config user.email', { encoding: 'utf8' }).trim().toLowerCase();
  } catch (err) {
    return '';
  }
}

// =====================================================================
// 各項偵測
// =====================================================================

/**
 * 電郵地址：安全網域以外一律高風險。
 * 額外放行目前 git author 嘅電郵（commit message 嘅 Co-Authored-By 會出現）。
 */
function scanEmails(lines, authorEmail) {
  const pattern = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  const findings = [];
  lines.forEach(function (l) {
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(l.text)) !== null) {
      const full = m[0];
      const domain = m[1];
      if (authorEmail && full.toLowerCase() === authorEmail) continue;
      if (SAFE_DOMAIN_PATTERNS.some(function (p) { return p.test(domain); })) continue;
      findings.push({
        severity: 'HIGH', kind: '電郵地址',
        file: l.file, line: l.line, match: full,
        hint: '不在安全網域清單內。測試／文件請一律用 example.invalid 或 x.com。'
      });
    }
  });
  return findings;
}

/**
 * 真實存在嘅頂級網域（只列常見嘅）＋ 任何兩個字母嘅國碼 TLD。
 *
 * ⚠️ **一定要有呢個清單**：冇嘅話，`sheet.getRange`／`process.argv`／
 * `module.exports` 呢啲 JavaScript 屬性存取全部都會被當成網域
 * （`字.字` 嘅樣式一模一樣）。實測寫呢個 script 嗰陣就係噉——
 * 自我檢查一次過報咗 39 個「網域」，全部都係 JS 語法。
 * 一個成日誤報嘅關卡等於冇關卡，因為人好快就會學識繞過佢。
 */
const REAL_TLD_PATTERN = new RegExp(
  '\\.(?:'
  + 'com|org|net|edu|gov|mil|int|info|biz|name|pro|coop|museum'
  + '|io|dev|app|co|me|tv|cc|xyz|site|online|store|blog|wiki|club'
  + '|church|faith|ngo|charity|foundation|community'
  // ⚠️ **唔可以用 `[a-z]{2}` 泛指國碼 TLD**：噉樣寫嘅話 `parsed.ok`／
  // `result.up` 呢類 JS 屬性存取全部會被當成網域。實測就係噉——
  // `parsed.ok` 被報成高風險網域。改用明確嘅國碼清單。
  //
  // 代價：用咗清單以外國碼嘅網域會漏。實際會出現嘅國碼同常見頂層網域
  // 都已經覆蓋到；日後有需要就喺下面個清單直接加。
  //
  // （呢度**特登唔舉完整網域做例子**——寫 `xxx.<國碼>` 呢種完整形狀
  //   會被呢個 script 自己嘅自我檢查捉到，實測就係噉。）
  + '|nz|au|hk|tw|cn|sg|my|uk|ca|us|jp|kr|ph|id|th|in'
  + ')$', 'i');

/**
 * 網域：安全清單以外嘅網域一律高風險（教會網域就係靠呢條捉，
 * 唔需要——亦都唔可以——喺呢度寫低佢係咩）。
 */
/**
 * 同時係真實頂層網域、又係極常見 JS 屬性名嘅字。
 * 呢批要出現喺引號入面（或者散文入面）先當成網域——見 scanDomains() 入面嘅說明。
 */
const AMBIGUOUS_TLDS = [
  'name', 'link', 'date', 'page', 'app', 'dev', 'co', 'id', 'info',
  'email', 'site', 'store', 'blog', 'wiki', 'club', 'online', 'pro'
];

/** 把字串轉成可以安全放入 RegExp 嘅樣式。 */
function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scanDomains(lines) {
  const pattern = /\b((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})\b/g;
  const findings = [];
  const seen = new Set();

  lines.forEach(function (l) {
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(l.text)) !== null) {
      const domain = m[1];
      const lower = domain.toLowerCase();

      // 最後一段唔係真 TLD ⇒ 唔係網域（多數係 `物件.屬性` 嘅程式碼）
      if (!REAL_TLD_PATTERN.test(lower)) continue;
      if (SAFE_DOMAIN_PATTERNS.some(function (p) { return p.test(lower); })) continue;
      // 常見檔名／版本號／縮寫
      if (/\.(js|gs|json|md|html|css|txt|ics|pdf|png|jpg|svg|ya?ml|lock|sh|ts)$/i.test(lower)) continue;
      if (/^\d+(\.\d+)+$/.test(lower)) continue;
      if (/^(e\.g|i\.e|etc|vs|no)\./i.test(lower)) continue;

      // ⚠️ 有一批真實嘅頂層網域同時係極常見嘅 JS 屬性名（見下面
      // `AMBIGUOUS_TLDS`）。`物件.屬性` 呢種寫法完全符合「網域」嘅形狀，
      // 而且結尾真係一個合法 TLD，所以上面嗰個 TLD 檢查攔唔到。
      //
      // 實測：第十九輪 commit 前掃描被 `tools/scan-static-risks.js` 入面
      // 一句拼接檔案路徑嘅程式碼擋住——關卡本身運作正常，但係誤判。
      //
      // （呢度**特登唔舉完整例子**：寫 `物件.屬性` 呢種完整形狀出嚟，
      //   會被呢個 script 自己嘅自我檢查捉到。同上面國碼清單同一個道理。）
      //
      // 做法：呢批「歧義 TLD」要**出現喺引號入面**先當成網域。
      // 真正嘅網域喺呢個 repo 出現嘅方式，一係喺字串（URL、設定值），
      // 一係喺 Markdown 散文——後者亦都當成要報（下面 inProse 嗰個判斷）。
      //
      // 代價：一個用歧義 TLD 而且喺純程式碼位置出現嘅真網域會漏。
      // 教會網域係 `.org`／`.nz`／`.com` 呢類，唔喺呢個清單入面，
      // 所以實際風險好低。
      if (AMBIGUOUS_TLDS.some(function (t) { return lower.endsWith('.' + t); })) {
        const quoted = new RegExp('["\'`][^"\'`]*' + escapeForRegex(domain) + '[^"\'`]*["\'`]');
        const inProse = /^(?:docs|README)/.test(l.file) || /^\s*(?:\/\/|\*|#)/.test(l.text);
        if (!quoted.test(l.text) && !inProse) continue;
      }

      const key = l.file + '|' + lower;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({
        severity: 'HIGH', kind: '網域',
        file: l.file, line: l.line, match: domain,
        hint: '不在安全網域清單內。如果這是教會網域或任何真實網域，'
          + '不可以進入這個公開 repo；如果是新的公開技術網域，請加入 SAFE_DOMAIN_PATTERNS。'
      });
    }
  });
  return findings;
}

/**
 * PersonID：本專案格式係 `P` ＋ 3-4 位數字。
 *
 * ## 判斷準則（同呢個準則會漏咩，一齊寫低）
 *
 * **放行**：
 * 1. `P9xxx` —— 本專案文件／測試明文規定嘅**假 ID 慣例**（見
 *    docs/排表規則.md 與各測試檔），一律當假資料；
 * 2. 同一行入面出現格式示範前置詞（例如「例如 P0001」）——嗰個係 UI 提示
 *    或者註釋入面嘅格式說明，唔係真人。
 *
 * **其餘一律高風險。**
 *
 * ⚠️ **呢個準則會漏嘅情況**：如果真實名冊入面**啱巧有人嘅 PersonID 係
 * P9 開頭**，呢個掃描會當佢係假 ID 而放行。呢個係刻意接受嘅取捨——
 * 唔用 P9xxx 做假 ID 慣例嘅話，每個測試檔嘅假資料都會觸發警報，
 * 關卡就會因為太嘈而被人繞過（比漏一個更差）。
 * 緩解方法：名冊分配 PersonID 時避開 P9 開頭。呢一點寫咗喺
 * docs/系統範圍稽核.md 第十八輪批次階段 D。
 */
function scanPersonIds(lines) {
  const pattern = /\bP\d{3,4}\b/g;
  const findings = [];
  lines.forEach(function (l) {
    const hasDemoMarker = FORMAT_DEMO_MARKERS.some(function (mk) {
      return l.text.indexOf(mk) !== -1;
    });
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(l.text)) !== null) {
      const id = m[0];
      if (/^P9/.test(id)) continue;      // 準則 1：假 ID 慣例
      if (hasDemoMarker) continue;       // 準則 2：格式示範
      findings.push({
        severity: 'HIGH', kind: 'PersonID',
        file: l.file, line: l.line, match: id,
        hint: '看起來是真實 PersonID。測試／文件請一律用 P9xxx；'
          + '如果這是格式示範，請在同一行加「例如」之類的字眼。'
      });
    }
  });
  return findings;
}

/**
 * 中文姓名：**提示，唔係擋**。
 *
 * ## 點解只提示唔擋
 *
 * 唔可以喺呢個檔案寫死真實姓名（噉樣本身就係洩漏），所以只可以用
 * **樣式**：常見姓氏字 ＋ 1-2 個中文字。呢種做法一定會有 false positive
 * （「陳述」「李鄭屋」「王道」之類都會中），如果設計成「直接擋」，
 * 幹事／開發者好快就會學識用 `--no-verify` 繞過——嗰陣個關卡就等於冇。
 *
 * 所以呢一項係 `MEDIUM`：**列出嚟要人親眼確認**，但唔會令離開碼變 1。
 * 高風險嗰幾項（電郵／網域／PersonID）先會真正擋住 commit。
 *
 * ⚠️ 呢個取捨嘅代價：一個真實姓名如果冇被人留意到，係過得到呢個關卡嘅。
 * 所以 `tests/scan_sensitive.test.js` 嗰層（用外部參考檔做交叉核對）
 * 仍然要保留，兩層一齊先夠。
 */
// 常見姓氏（公開資訊，唔係任何特定人士嘅姓名）。
// 放喺 module scope 係因為要 export 出去畀測試用——測試要斷言
// 「一連串姓氏排住唔會被當成姓名」，唔應該喺測試度抄多份。
const SURNAMES = '陳李黃張林吳劉蔡楊許鄭謝郭洪曾廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾游詹胡施沈余盧梁趙顏柯翁魏孫戴范方宋鄧杜傅侯曹薛丁卓阮馬董温唐藍石蔣古紀姚連馮歐程湯田白邱';

function scanChineseNames(lines) {
  // ⚠️ **前後都唔可以加漢字邊界 lookaround**。中文行文入面，一個姓名嘅
  // 前後幾乎一定係中文字——「今次由陳大明負責」入面，`陳` 前面係 `由`、
  // `明` 後面係 `負`。加咗任何一邊嘅負向邊界，running text 入面嘅姓名
  // 就會一個都捉唔到，而測試表面上仍然「冇誤報」，睇落好似正常運作。
  //
  // 實測寫呢個 script 嗰陣兩個版本都試過，兩次都係零偵測——係自己寫嘅
  // 正向測試（「陳大明要捉到」）先揭穿咗，唔係靠肉眼睇。
  //
  // 代價：冇邊界限制 ⇒ 誤報一定多（「陳述」「王道」「李鄭屋」都會中）。
  // 所以呢一項係 MEDIUM（提示），唔會擋 commit——見函式開頭嘅取捨說明。
  const pattern = new RegExp('([' + SURNAMES + '][\\p{Script=Han}]{1,2})', 'gu');

  const findings = [];
  const seen = new Set();

  lines.forEach(function (l) {
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(l.text)) !== null) {
      const name = m[1];
      if (KNOWN_FICTIONAL_NAMES.has(name)) continue;
      if (STRUCTURAL_STOPWORDS.has(name)) continue;

      // 姓氏做開頭嘅常用詞（方法就／連續型／程式碼……）
      if (WORD_HEADS.some(function (w) { return name.indexOf(w) === 0; })) continue;

      // 姓氏做第二個字嘅常用詞（任何身分／流程圖／空白格……）：
      // 要睇返匹配位置前面嗰個字先分辨得到。
      const prev = m.index > 0 ? l.text.charAt(m.index - 1) : '';
      if (prev && WORD_TAILS.indexOf(prev + name.charAt(0)) !== -1) continue;

      // 一連串姓氏排住（例如呢個 script 自己嘅 SURNAMES 表、或者姓氏
      // 參考清單）唔係姓名。用「係咪 SURNAMES 嘅連續子字串」判斷——
      // 三個字全部啱啱好喺表入面相鄰，實際上唔會係一個人嘅名。
      if (SURNAMES.indexOf(name) !== -1) continue;

      const key = l.file + '|' + name;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({
        severity: 'MEDIUM', kind: '疑似中文姓名',
        file: l.file, line: l.line, match: name,
        hint: '這一項一定會有誤判（例如「陳述」「王道」「李鄭屋」都會中），'
          + '所以只提示、不會擋住 commit。請親眼確認這不是真人姓名。'
      });
    }
  });
  return findings;
}

// =====================================================================
// 主流程
// =====================================================================

function main() {
  let lines;
  try {
    lines = readStagedAddedLines();
  } catch (err) {
    console.error('✗ ' + err.message);
    process.exit(1);
  }

  if (lines.length === 0) {
    const empty = { ok: true, staged: 0, high: [], medium: [] };
    if (JSON_OUTPUT) { console.log(JSON.stringify(empty, null, 2)); }
    else { console.log('沒有 staged 內容，不需要掃描。'); }
    process.exit(0);
  }

  const authorEmail = readGitAuthorEmail();
  const findings = []
    .concat(scanEmails(lines, authorEmail))
    .concat(scanDomains(lines))
    .concat(scanPersonIds(lines))
    .concat(scanChineseNames(lines));

  const high = findings.filter(function (f) { return f.severity === 'HIGH'; });
  const medium = findings.filter(function (f) { return f.severity === 'MEDIUM'; });

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      ok: high.length === 0,
      staged: lines.length,
      high: high, medium: medium
    }, null, 2));
    process.exit(high.length === 0 ? 0 : 1);
  }

  const files = new Set(lines.map(function (l) { return l.file; }));
  console.log('掃描 staged 內容：' + files.size + ' 個檔案、' + lines.length + ' 行新增內容\n');

  if (high.length > 0) {
    console.log('✗ 高風險項目 ' + high.length + ' 項——**拒絕 commit**\n');
    high.forEach(function (f) {
      console.log('  [' + f.kind + '] ' + f.file + ':' + f.line);
      console.log('      找到：' + f.match);
      console.log('      ' + f.hint + '\n');
    });
  }

  if (medium.length > 0) {
    console.log((high.length > 0 ? '' : '⚠ ')
      + '提示項目 ' + medium.length + ' 項（不會擋住 commit，但請親眼確認）\n');
    medium.slice(0, 30).forEach(function (f) {
      console.log('  [' + f.kind + '] ' + f.file + ':' + f.line + '　' + f.match);
    });
    if (medium.length > 30) console.log('  ……另有 ' + (medium.length - 30) + ' 項');
    console.log('');
  }

  if (high.length === 0 && medium.length === 0) {
    console.log('✓ 通過：沒有發現高風險項目，也沒有需要確認的提示。');
  } else if (high.length === 0) {
    console.log('✓ 通過（有 ' + medium.length + ' 項提示需要你自己確認過）。');
  }

  process.exit(high.length === 0 ? 0 : 1);
}

// 供測試 require 用；直接執行先跑 main()
if (require.main === module) {
  main();
} else {
  module.exports = {
    readStagedAddedLines, scanEmails, scanDomains, scanPersonIds, scanChineseNames,
    SAFE_DOMAIN_PATTERNS, KNOWN_FICTIONAL_NAMES, FORMAT_DEMO_MARKERS,
    SURNAMES, WORD_HEADS, WORD_TAILS, parseStagedDiff
  };
}
