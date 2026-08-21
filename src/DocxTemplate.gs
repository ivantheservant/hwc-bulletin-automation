/**
 * DocxTemplate.gs
 *
 * Word（OOXML）範本渲染的**純 XML 操作層**。全部函式的輸入輸出都是字串
 * 或陣列，**完全不碰任何 Google 服務**（沒有 `SpreadsheetApp`、沒有
 * `DriveApp`、沒有 `Utilities`），所以可以在 Node 直接測試。
 *
 * IO（讀範本檔、解壓、壓縮、寫檔）一律在 `src/DocxIo.gs`；
 * 資料模型 → 佔位符的轉換在 `src/BulletinRender.gs`。三層不可以混。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為什麼是 `.docx` 而不是 PDF（決策記錄）
 * ─────────────────────────────────────────────────────────────────────
 *
 * Apps Script 沒有辦法把 `.docx` 直接轉成 PDF。唯一途徑是先轉成 Google
 * Docs 格式，而那一步會**丟失文字方塊與圓角矩形**、破壞三欄 section 與
 * A5 兩頁併印、把商業港式字型代換成其他字體——等於把版面重做一次。
 *
 * 所以本系統**交付 `.docx`**：版面 100% 不變，因為我們從來不重畫它，
 * 只換字。教會現行做法本來就是用 Word 開檔再印。
 *
 * ⚠️ 由此推出本檔案最重要的一條紀律：**只動 `<w:t>` 裡面的文字與整列／
 * 整段的增刪，其餘一個位元都不碰。** 不要嘗試「順手」整理 XML、
 * 重新縮排、移除看似多餘的標籤——那些東西是版面的一部分。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 最大的坑：Word 會把一個佔位符拆成多個 `<w:r>`
 * ─────────────────────────────────────────────────────────────────────
 *
 * 因為拼寫檢查、語言標記、樣式殘留，Word 經常把 `{{SERMON_TITLE}}` 存成
 * 三個 run：`{{`／`SERMON`／`_TITLE}}`。**直接做字串替換一定會失敗**，
 * 而且失敗的方式很難察覺——佔位符原樣留在成品上，看起來像「範本做錯」。
 *
 * 所以替換之前**必須**先跑 `mergeRunsInParagraphs_()`。見
 * docs/已知bug類型.md 的「Word 會把一個佔位符拆成多個 run」。
 */

'use strict';

// =====================================================================
// XML 標籤掃描——正確配對開合標籤，處理巢狀
// =====================================================================

/**
 * 用途：由一個 `<` 的位置出發，找出這個標籤的結束位置（`>` 的下一格）。
 *   會正確跳過屬性值引號內的 `>`。
 * Args:
 *   xml {string} 整份 XML。
 *   ltIndex {number} `<` 所在的索引。
 * Returns:
 *   {number} 標籤結束後的索引（exclusive）；找不到 `>` 時回 `xml.length`。
 */
function findTagEnd_(xml, ltIndex) {
  var i = ltIndex + 1;
  var quote = '';
  while (i < xml.length) {
    var ch = xml.charAt(i);
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
    i++;
  }
  return xml.length;
}

/**
 * 用途：找出指定標籤名稱在 XML 內全部的開／合／自閉標籤位置。
 *
 *   ⚠️ 標籤名稱一定要**完整比對**：找 `w:tr` 的時候不可以連 `w:trPr`
 *   一起捉到。所以名稱後面必須緊接空白、`>` 或 `/`。
 * Args:
 *   xml {string} 整份 XML。
 *   tag {string} 標籤名稱，含命名空間前綴，例如 `'w:tr'`。
 * Returns:
 *   {{type:string, start:number, end:number}[]} `type` 是
 *     `'open'`／`'close'`／`'self'`，依出現次序排列。
 */
function scanTagPositions_(xml, tag) {
  var positions = [];
  var openPrefix = '<' + tag;
  var closePrefix = '</' + tag;
  var i = 0;

  while (i < xml.length) {
    var lt = xml.indexOf('<', i);
    if (lt === -1) break;

    if (xml.substr(lt, closePrefix.length) === closePrefix) {
      var afterClose = xml.charAt(lt + closePrefix.length);
      if (afterClose === '>' || afterClose === ' ' || afterClose === '\t' || afterClose === '\n' || afterClose === '\r') {
        var closeEnd = findTagEnd_(xml, lt);
        positions.push({ type: 'close', start: lt, end: closeEnd });
        i = closeEnd;
        continue;
      }
    }

    if (xml.substr(lt, openPrefix.length) === openPrefix) {
      var afterOpen = xml.charAt(lt + openPrefix.length);
      if (afterOpen === '>' || afterOpen === '/' || afterOpen === ' ' || afterOpen === '\t' || afterOpen === '\n' || afterOpen === '\r') {
        var openEnd = findTagEnd_(xml, lt);
        var isSelfClosing = xml.charAt(openEnd - 2) === '/';
        positions.push({ type: isSelfClosing ? 'self' : 'open', start: lt, end: openEnd });
        i = openEnd;
        continue;
      }
    }

    i = lt + 1;
  }

  return positions;
}

/**
 * 用途：找出指定標籤名稱在 XML 內全部**完整配對**的元素範圍，含巢狀。
 *
 *   ⚠️ 這就是 prompt7「不要用正則表達式硬拆 `<w:tr>` 而不處理巢狀表格」
 *   那一條的實作：`<w:tr>` 可以透過 `<w:tc>` → `<w:tbl>` → `<w:tr>`
 *   巢狀好幾層，用 `/<w:tr>[\s\S]*?<\/w:tr>/` 這種寫法會在第一個
 *   `</w:tr>` 就切斷，把外層的列砍成兩半、產生壞掉的 XML。
 * Args:
 *   xml {string} 整份 XML。
 *   tag {string} 標籤名稱，例如 `'w:tr'`、`'w:p'`、`'w:r'`。
 * Returns:
 *   {{start:number, end:number, depth:number}[]} `depth` 是巢狀深度
 *     （最外層為 0）。依 `start` 由小到大排序。自閉標籤也會列入
 *     （`start`／`end` 就是那個標籤本身）。
 */
function findElementRanges_(xml, tag) {
  var positions = scanTagPositions_(xml, tag);
  var stack = [];
  var ranges = [];

  positions.forEach(function (pos) {
    if (pos.type === 'self') {
      ranges.push({ start: pos.start, end: pos.end, depth: stack.length });
      return;
    }
    if (pos.type === 'open') {
      stack.push(pos.start);
      return;
    }
    // close
    if (stack.length === 0) return; // 不成對的合標籤：略過，不要讓整份 XML 爆掉
    var openStart = stack.pop();
    ranges.push({ start: openStart, end: pos.end, depth: stack.length });
  });

  ranges.sort(function (a, b) { return a.start - b.start; });
  return ranges;
}

/**
 * 用途：找出**最內層**包含指定位置的元素範圍。
 *
 *   佔位符標記（`{{#EACH:...}}`／`{{#IF:...}}`）落在哪一列／哪一段，
 *   語意上一定是指**最貼身**的那一個，所以取最內層（範圍最短的）。
 * Args:
 *   ranges {{start:number, end:number}[]} `findElementRanges_()` 的輸出。
 *   index {number} 要查的位置。
 * Returns:
 *   {?{start:number, end:number}} 找不到回 `null`。
 */
function innermostRangeContaining_(ranges, index) {
  var best = null;
  ranges.forEach(function (r) {
    if (r.start > index || r.end <= index) return;
    if (best === null || (r.end - r.start) < (best.end - best.start)) best = r;
  });
  return best;
}

/**
 * 用途：把一批「範圍 → 新內容」的替換一次過套用到字串上。
 *
 *   ⚠️ 一律**由後向前**套用：先改後面的範圍，前面範圍的索引才不會位移。
 *   這是本檔案全部「改一批列」的操作共用的做法。
 * Args:
 *   xml {string} 原始字串。
 *   edits {{start:number, end:number, text:string}[]} 範圍不可以互相重疊。
 * Returns:
 *   {string}
 */
function applyRangeEdits_(xml, edits) {
  var sorted = edits.slice().sort(function (a, b) { return b.start - a.start; });
  var out = xml;
  sorted.forEach(function (e) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  });
  return out;
}

// =====================================================================
// 文字跳脫與換行
// =====================================================================

/**
 * 用途：把文字跳脫成可以安全放進 XML 文字節點的形式（`&`／`<`／`>`）。
 *
 *   ⚠️ **已經跳脫過的實體不會被重複跳脫**：`&amp;` 保持 `&amp;`，
 *   不會變成 `&amp;amp;`。判斷方式是看 `&` 後面是不是一個合法的實體
 *   （具名實體或數值實體）。這一點很重要——範本本身的內容已經是跳脫過
 *   的 XML，而使用者填的值是未跳脫的純文字，兩者會在同一條路徑上流過。
 * Args:
 *   s {*} 任意值，會先轉成字串；`null`／`undefined` 當空字串。
 * Returns:
 *   {string}
 */
function escapeXmlText_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;');
}

/**
 * 用途：把一個**要填進範本的值**轉成可以直接塞進 `<w:t>` 的 Word 文字。
 *   全部值一律經過這個函式，不可以繞過。
 *
 *   做三件事：
 *
 *   1. XML 跳脫（見 `escapeXmlText_()`）。
 *
 *   2. 把換行 `\n` 轉成 Word 的換行元素
 *      `</w:t><w:br/><w:t xml:space="preserve">`。
 *      ⚠️ 為什麼不能原樣塞進去：`<w:t>` 內的換行字元 Word 完全不當一回事，
 *      會把整段顯示成一行。家事報告、代禱事項這類多行內容一定會中招。
 *      `\r\n`／`\r` 會先正規化成 `\n`，所以由 Windows 貼上來的文字一樣正常；
 *      連續兩個 `\n` 產生兩個 `<w:br/>`（空行保留）。
 *
 *   3. **把大括號換成數值字元參照**（`{` → `&#123;`、`}` → `&#125;`）。
 *      ⚠️ 這一條是防「二次替換」的關鍵：整個渲染流程是**多趟**的
 *      （先展開重複列、最後才替換單值），所以先被填進去的值，會再經過
 *      後面幾趟掃描。如果某一則家事報告的內容剛好寫住
 *      `{{SERMON_TITLE}}`（人手打的普通文字），最後那一趟單值替換就會
 *      把它當成佔位符換掉——使用者填的字被系統偷偷改寫，而且完全無聲。
 *      換成數值參照之後，Word 照樣顯示 `{`／`}`，但後面的掃描再也認不出
 *      它是佔位符。這是「值一律只當資料、永不當程式碼」的具體做法。
 * Args:
 *   s {*} 任意值。
 * Returns:
 *   {string} 可以直接放進 `<w:t>...</w:t>` 之間的字串。
 */
function toWordText_(s) {
  var normalized = String(s === null || s === undefined ? '' : s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var parts = normalized.split('\n').map(function (part) {
    return escapeXmlText_(part).split('{').join('&#123;').split('}').join('&#125;');
  });
  return parts.join('</w:t><w:br/><w:t xml:space="preserve">');
}

// =====================================================================
// 合併被拆散的 run（替換之前一定要先做）
// =====================================================================

/**
 * 兩個 `<w:r>` 之間可以安全丟棄的元素。
 *
 * `<w:proofErr>` 是拼寫／文法檢查的標記，`<w:noProof>` 是「不要檢查」的
 * 標記——兩者都**純粹是編輯器的中繼資料，跟版面與內容完全無關**，
 * 而且正正是 Word 把佔位符切成好幾個 run 時插在中間的東西。丟掉它們是
 * 安全的，也是讓合併能夠成功的關鍵。
 *
 * ⚠️ 其餘任何元素（書籤、註解錨點、欄位代碼……）一律**阻擋合併**，
 * 因為丟掉它們會改變文件。寧可合併失敗被 `findBrokenPlaceholders_()`
 * 報出來，也不要靜靜破壞版面。
 */
function droppableBetweenRunsTags_() {
  return ['w:proofErr', 'w:noProof'];
}

/**
 * 用途：判斷兩個 run 之間的內容是不是「可以安全丟棄」——只有空白，
 *   以及 `droppableBetweenRunsTags_()` 列出的中繼資料標籤。
 * Args:
 *   between {string} 兩個 run 之間的原始 XML 片段。
 * Returns:
 *   {boolean}
 */
function isDroppableBetweenRuns_(between) {
  var rest = between;
  droppableBetweenRunsTags_().forEach(function (tag) {
    var pattern = new RegExp('<' + tag.replace(':', '\\:') + '\\b[^>]*/?>', 'g');
    rest = rest.replace(pattern, '');
    rest = rest.split('</' + tag + '>').join('');
  });
  return rest.trim() === '';
}

/**
 * 用途：把一個 `<w:r>` 的原始 XML 拆成「格式（`<w:rPr>` 原文）」與
 *   「文字內容（全部 `<w:t>` 的內容串起來）」。
 * Args:
 *   runXml {string} 一個完整的 `<w:r>...</w:r>`。
 * Returns:
 *   {?{rPr:string, text:string}} 這個 run **不只含 `<w:t>`**（例如還有
 *     `<w:drawing>`／`<w:tab/>`／`<w:br/>`／`<w:fldChar>`）時回 `null`，
 *     代表「不可合併」——合併它會丟失內容。
 */
function parseSimpleRun_(runXml) {
  var openEnd = findTagEnd_(runXml, 0);
  var closeStart = runXml.lastIndexOf('</w:r');
  if (closeStart < openEnd) return null;
  var inner = runXml.slice(openEnd, closeStart);

  var rPr = '';
  var rPrRanges = findElementRanges_(inner, 'w:rPr').filter(function (r) { return r.depth === 0; });
  if (rPrRanges.length > 0) {
    rPr = inner.slice(rPrRanges[0].start, rPrRanges[0].end);
    inner = inner.slice(0, rPrRanges[0].start) + inner.slice(rPrRanges[0].end);
  }

  var text = '';
  var consumed = '';
  var tRanges = findElementRanges_(inner, 'w:t').filter(function (r) { return r.depth === 0; });
  tRanges.forEach(function (r) {
    var whole = inner.slice(r.start, r.end);
    consumed += whole;
    var tOpenEnd = findTagEnd_(whole, 0);
    var tCloseStart = whole.lastIndexOf('</w:t');
    if (tCloseStart >= tOpenEnd) text += whole.slice(tOpenEnd, tCloseStart);
  });

  // 除了 <w:rPr> 與 <w:t> 以外還有其他東西 ⇒ 不可合併。
  var leftover = inner;
  tRanges.slice().reverse().forEach(function (r) {
    leftover = leftover.slice(0, r.start) + leftover.slice(r.end);
  });
  if (leftover.trim() !== '') return null;
  if (consumed === '' ) return null; // 完全沒有 <w:t>：不是文字 run

  return { rPr: rPr, text: text };
}

/**
 * 用途：在每個 `<w:p>` 之內，把**格式完全相同**（`<w:rPr>` 內容一字不差）
 *   的相鄰 `<w:r>` 合併成一個，並把它們的 `<w:t>` 內容串起來。
 *
 *   **這是整個渲染流程的第一步，而且不可以省略**——見本檔案檔頭
 *   「Word 會把一個佔位符拆成多個 run」的說明。
 *
 *   合併規則（保守，寧可不合併也不要破壞文件）：
 *     - 只合併「只含 `<w:rPr>` 與 `<w:t>`」的 run（見 parseSimpleRun_()）
 *     - `<w:rPr>` 原文必須一字不差相同
 *     - 兩者之間只准夾空白與拼寫檢查標記（見 droppableBetweenRunsTags_()）
 *     - 合併結果一律寫成 `xml:space="preserve"`，**避免前後空白被 Word
 *       吃掉**——原本分開的 run 各自可能有／沒有這個屬性，串起來之後
 *       空白的位置變了，不加這個屬性會出現「祈禱會 眾坐」變成
 *       「祈禱會眾坐」這種錯。
 *
 *   ⚠️ 巢狀段落（文字方塊 `<w:txbxContent>` 內也有 `<w:p>`）用「最內層
 *   包含這個 run 的 `<w:p>`」歸屬，所以文字方塊內的 run 不會跟外層段落
 *   的 run 混在一起合併。本份週報有 8–20 個文字方塊，這一點是必要的。
 * Args:
 *   xml {string} `word/document.xml` 的內容。
 * Returns:
 *   {string} 合併後的 XML。輸入沒有任何可合併的 run 時原樣回傳。
 */
function mergeRunsInParagraphs_(xml) {
  var paragraphRanges = findElementRanges_(xml, 'w:p');
  var runRanges = findElementRanges_(xml, 'w:r');

  // 依「最內層包含它的段落」把 run 分組。沒有段落包住的 run 不處理。
  var groupsByParagraph = {};
  runRanges.forEach(function (run) {
    var owner = innermostRangeContaining_(paragraphRanges, run.start);
    if (!owner) return;
    var key = owner.start + ':' + owner.end;
    if (!groupsByParagraph[key]) groupsByParagraph[key] = [];
    groupsByParagraph[key].push(run);
  });

  var edits = [];

  Object.keys(groupsByParagraph).forEach(function (key) {
    var runs = groupsByParagraph[key].slice().sort(function (a, b) { return a.start - b.start; });
    var i = 0;

    while (i < runs.length) {
      var first = parseSimpleRun_(xml.slice(runs[i].start, runs[i].end));
      if (!first) { i++; continue; }

      var group = [{ range: runs[i], parsed: first }];
      var j = i + 1;

      while (j < runs.length) {
        var between = xml.slice(runs[j - 1].end, runs[j].start);
        if (!isDroppableBetweenRuns_(between)) break;

        var next = parseSimpleRun_(xml.slice(runs[j].start, runs[j].end));
        if (!next) break;
        if (next.rPr !== first.rPr) break;

        group.push({ range: runs[j], parsed: next });
        j++;
      }

      if (group.length > 1) {
        var mergedText = group.map(function (g) { return g.parsed.text; }).join('');
        edits.push({
          start: group[0].range.start,
          end: group[group.length - 1].range.end,
          text: '<w:r>' + first.rPr + '<w:t xml:space="preserve">' + mergedText + '</w:t></w:r>'
        });
      }

      i = j > i ? j : i + 1;
    }
  });

  return edits.length === 0 ? xml : applyRangeEdits_(xml, edits);
}

// =====================================================================
// 佔位符盤點
// =====================================================================

/**
 * 用途：列出 XML 內出現過的全部佔位符（去重，含類型）。
 *
 *   ⚠️ **標記類（`#EACH:`／`#EACHP:`／`#IF:`／`#IFP:`）一律不可以歸入
 *   `'SIMPLE'`**——那樣會被對帳邏輯當成「範本用到的單值佔位符」去跟
 *   `supportedValuePlaceholderNames_()` 比對，一定對不上（那份清單裡
 *   根本不會有帶 `#` 開頭的名字），誤報成「範本用到但系統不提供」。
 *   `#EACH:` 與 `#EACHP:` 是**清單標記**（分別對應列層／段落層展開，
 *   見 `expandEachRows_()`／`expandEachParagraphs_()`），`#IF:` 與
 *   `#IFP:` 是**條件標記**（分別對應條件列／條件段落）——四種都要先
 *   認出前綴、剝掉前綴才算出 `name`。事故十九就是 `#EACHP:` 這個前綴
 *   當時沒有對到任何一個分支、落到最後的 `'SIMPLE'` 預設值，見
 *   docs/已知bug類型.md。
 * Args:
 *   xml {string} `word/document.xml` 的內容（建議先跑過
 *     `mergeRunsInParagraphs_()`，否則被切斷的佔位符找不到）。
 * Returns:
 *   {{name:string, type:string, raw:string}[]} `type` 是
 *     `'SIMPLE'`（`{{KEY}}`）／`'EACH'`（`{{#EACH:LIST}}`，清單標記）／
 *     `'EACHP'`（`{{#EACHP:LIST}}`，清單標記，段落層）／
 *     `'IF'`（`{{#IF:KEY}}`，條件標記）／
 *     `'IFP'`（`{{#IFP:KEY}}`，條件標記）／
 *     `'FIELD'`（`{{LIST.FIELD}}`）。依 `raw` 字母序排序，方便比對。
 */
function findPlaceholders_(xml) {
  var seen = {};
  var out = [];
  var pattern = /\{\{([#A-Z0-9_.:]+)\}\}/g;
  var m;

  while ((m = pattern.exec(String(xml || ''))) !== null) {
    var body = m[1];
    var raw = m[0];
    if (seen[raw]) continue;
    seen[raw] = true;

    var type = 'SIMPLE';
    var name = body;
    // ⚠️ #EACHP: 一定要排在 #EACH: 前面判斷：雖然 '#EACHP:X'.indexOf('#EACH:')
    // 本來就不會命中（第 6 個字元 'P' 跟 ':' 對不上），但兩個標記字面上
    // 前綴很像，排錯次序日後很容易在改動時不小心踩到，寫死次序比較保險。
    if (body.indexOf('#EACHP:') === 0) { type = 'EACHP'; name = body.slice('#EACHP:'.length); }
    else if (body.indexOf('#EACH:') === 0) { type = 'EACH'; name = body.slice('#EACH:'.length); }
    else if (body.indexOf('#IFP:') === 0) { type = 'IFP'; name = body.slice('#IFP:'.length); }
    else if (body.indexOf('#IF:') === 0) { type = 'IF'; name = body.slice('#IF:'.length); }
    else if (body.indexOf('.') !== -1) { type = 'FIELD'; }

    out.push({ name: name, type: type, raw: raw });
  }

  out.sort(function (a, b) { return a.raw < b.raw ? -1 : (a.raw > b.raw ? 1 : 0); });
  return out;
}

/**
 * 用途：找出**疑似被切斷**的佔位符——合併 run 之後仍然跨 `<w:t>` 的，
 *   或者有頭無尾（`{{` 找不到對應的 `}}`）、有尾無頭的。
 *
 *   ⚠️ **不可以靜靜略過。** 一個被切斷的佔位符不會拋錯、不會被替換，
 *   只會原樣印在成品週報上——那是最糟的失敗方式（看起來像人手做錯，
 *   而且要到印出來才發現）。所以一定要收集成 warning 報告出來。
 *
 *   會走到這裡代表 `mergeRunsInParagraphs_()` 合併不了（中間夾了書籤、
 *   欄位代碼，或者兩半的字型真的不同）。實務上的修法是叫 Ivan 在 Word
 *   把那個佔位符整段刪掉重新打一次——見 docs/Word範本製作指引.md。
 * Args:
 *   xml {string} 建議是 `mergeRunsInParagraphs_()` 之後的 XML。
 * Returns:
 *   {{kind:string, text:string, paragraphIndex:number}[]} `kind` 是
 *     `'SPLIT_ACROSS_RUNS'`（跨 `<w:t>`）／`'UNCLOSED'`（有頭無尾）／
 *     `'UNOPENED'`（有尾無頭）。
 */
function findBrokenPlaceholders_(xml) {
  var source = String(xml || '');
  var paragraphs = findElementRanges_(source, 'w:p');
  var findings = [];

  // 沒有任何 <w:p> 的話（例如測試用的碎片），把整份當成一段來檢查。
  var scopes = paragraphs.length > 0
    ? paragraphs.filter(function (p) {
      // 只看最內層段落，避免巢狀段落（文字方塊）被重複報一次
      return !paragraphs.some(function (q) {
        return q !== p && q.start >= p.start && q.end <= p.end && (q.end - q.start) < (p.end - p.start);
      });
    })
    : [{ start: 0, end: source.length }];

  scopes.forEach(function (scope, scopeIndex) {
    var scopeXml = source.slice(scope.start, scope.end);
    var segments = [];
    var tRanges = findElementRanges_(scopeXml, 'w:t');

    tRanges.forEach(function (r) {
      var whole = scopeXml.slice(r.start, r.end);
      var openEnd = findTagEnd_(whole, 0);
      var closeStart = whole.lastIndexOf('</w:t');
      if (closeStart < openEnd) return;
      segments.push({ text: whole.slice(openEnd, closeStart), index: segments.length });
    });

    if (segments.length === 0) return;

    // 把全部 <w:t> 串起來，同時記住每個字元屬於第幾個 <w:t>。
    var joined = '';
    var ownerBySegment = [];
    segments.forEach(function (seg) {
      for (var k = 0; k < seg.text.length; k++) ownerBySegment.push(seg.index);
      joined += seg.text;
    });

    var pos = 0;
    while (pos < joined.length) {
      var open = joined.indexOf('{{', pos);
      if (open === -1) break;

      var close = joined.indexOf('}}', open + 2);
      if (close === -1) {
        findings.push({
          kind: 'UNCLOSED',
          text: joined.slice(open, Math.min(open + 40, joined.length)),
          paragraphIndex: scopeIndex
        });
        break;
      }

      if (ownerBySegment[open] !== ownerBySegment[close + 1]) {
        findings.push({
          kind: 'SPLIT_ACROSS_RUNS',
          text: joined.slice(open, close + 2),
          paragraphIndex: scopeIndex
        });
      }

      pos = close + 2;
    }

    // 有尾無頭：把全部成對的先移走，剩下的 `}}` 就是孤立的。
    var withoutPairs = joined.replace(/\{\{[^{}]*\}\}/g, '');
    if (withoutPairs.indexOf('}}') !== -1 && withoutPairs.indexOf('{{') === -1) {
      findings.push({ kind: 'UNOPENED', text: '}}', paragraphIndex: scopeIndex });
    }
  });

  return findings;
}

// =====================================================================
// 替換：單值
// =====================================================================

/**
 * 用途：把 `{{KEY}}` 形式的單值佔位符換成對應的值（規約 2.1）。
 *
 *   ⚠️ **單次掃描，不會二次替換**：用一次 `replace()` 加 callback 完成，
 *   所以值本身如果含有 `{{...}}`（例如使用者真的打了兩個大括號），
 *   不會被當成另一個佔位符再替換一次。用「替換完再掃一次」的寫法就會
 *   中招，這是刻意避開的。
 *
 *   ⚠️ 只認 `[A-Z0-9_]+`：不含點的才是單值。`{{PROGRAM.ITEM}}` 是清單
 *   欄位，由 `expandEachRows_()` 負責，這裡一定不可以碰——次序見
 *   `renderDocumentXml_()`。
 * Args:
 *   xml {string} 要處理的 XML。
 *   values {Object<string,*>} 佔位符 → 值。
 *   mode {string} 找不到值時的處理：`'BLANK'`（換成空字串，預設）／
 *     `'KEEP'`（原樣保留，方便肉眼找出漏了哪個）／`'ERROR'`（拋錯）。
 * Returns:
 *   {{xml:string, replacedCount:number, missingKeys:string[]}}
 *     `missingKeys` 去重、依出現次序。
 * Raises:
 *   Error 當 `mode` 是 `'ERROR'` 而且真的有找不到值的佔位符。
 */
function replaceSimplePlaceholders_(xml, values, mode) {
  var lookup = values || {};
  var effectiveMode = mode || 'BLANK';
  var replacedCount = 0;
  var missingKeys = [];

  var out = String(xml || '').replace(/\{\{([A-Z0-9_]+)\}\}/g, function (whole, key) {
    if (Object.prototype.hasOwnProperty.call(lookup, key)) {
      replacedCount++;
      return toWordText_(lookup[key]);
    }

    if (missingKeys.indexOf(key) === -1) missingKeys.push(key);

    if (effectiveMode === 'ERROR') {
      throw new Error(
        'replaceSimplePlaceholders_：範本用到佔位符「' + whole + '」，但系統沒有提供這個值。'
        + '（Config 的 TEMPLATE_MISSING_VALUE_MODE 目前是 ERROR；'
        + '改成 BLANK 會換成空字串、改成 KEEP 會原樣保留。）'
      );
    }
    if (effectiveMode === 'KEEP') return whole;
    return '';
  });

  return { xml: out, replacedCount: replacedCount, missingKeys: missingKeys };
}

// =====================================================================
// 展開：重複列
// =====================================================================

/**
 * 用途：把一筆資料套進一個列範本——移除 `{{#EACH:...}}` 標記本身，
 *   並把 `{{PREFIX.FIELD}}` 換成該筆資料的欄位值。
 *
 *   支援多個前綴，是為了交錯展開（見 `expandInterleavedRows_()`）：
 *   全寬列的標記雖然是 `{{#EACH:PROGRAM_FW}}`，但它取的仍然是 `PROGRAM`
 *   這個清單的資料，所以 `{{PROGRAM.CONTENT}}` 與 `{{PROGRAM_FW.CONTENT}}`
 *   兩種寫法都要認得。對一個不懂程式、在 Word 逐格打佔位符的人來說，
 *   兩種都work才不會踩坑。
 * Args:
 *   templateXml {string} 一個完整的 `<w:tr>...</w:tr>` 列範本。
 *   row {Object} 一筆資料，key 是欄位名稱（大寫）。
 *   prefixes {string[]} 允許的清單前綴，例如 `['PROGRAM', 'PROGRAM_FW']`。
 *   markers {string[]} 要移除的標記，例如 `['{{#EACH:PROGRAM}}']`。
 * Returns:
 *   {string} 套好資料的一列 XML。
 */
function renderRowTemplate_(templateXml, row, prefixes, markers) {
  var out = String(templateXml || '');

  (markers || []).forEach(function (marker) {
    out = out.split(marker).join('');
  });

  var prefixAlternation = (prefixes || []).map(function (p) {
    return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|');
  if (!prefixAlternation) return out;

  var fieldPattern = new RegExp('\\{\\{(?:' + prefixAlternation + ')\\.([A-Z0-9_]+)\\}\\}', 'g');
  return out.replace(fieldPattern, function (whole, field) {
    if (row && Object.prototype.hasOwnProperty.call(row, field)) return toWordText_(row[field]);
    // 清單資料沒有這個欄位 ⇒ 換成空字串。這裡刻意不拋錯：範本可能預留
    // 了日後才會用到的欄位，硬擋住會讓整份週報生不出來。找不到的欄位會
    // 由 renderDocumentXml_() 收集成 warning 報出來。
    return '';
  });
}

/**
 * 用途：展開一個重複列範本（規約 2.2）。
 *
 *   一個 `<w:tr>` 內若出現 `{{#EACH:LIST_NAME}}`，該列就是列範本：
 *   引擎把它複製 N 次（N = 清單長度），逐次替換 `{{LIST_NAME.FIELD}}`，
 *   並移除 `{{#EACH:...}}` 標記本身。
 *
 *   ⚠️ **清單為空 → 整列刪除**（不是留一列空白）。空的家事報告表如果
 *   留一列空白，印出來會多一條莫名其妙的橫線。
 * Args:
 *   xml {string} 要處理的 XML。
 *   listName {string} 清單名稱，例如 `'ANNOUNCEMENT'`。
 *   rows {Object[]} 清單資料。
 * Returns:
 *   {{xml:string, expandedRows:number, found:boolean}} `found` 為 false
 *     代表範本內根本沒有這個列範本（不是錯誤——範本可以不用某個清單）。
 */
function expandEachRows_(xml, listName, rows) {
  var source = String(xml || '');
  var marker = '{{#EACH:' + listName + '}}';
  var markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return { xml: source, expandedRows: 0, found: false };

  var trRanges = findElementRanges_(source, 'w:tr');
  var templateRange = innermostRangeContaining_(trRanges, markerIndex);
  if (!templateRange) {
    // 標記不在任何 <w:tr> 內：把標記本身移走，不要留在成品上。
    return { xml: source.split(marker).join(''), expandedRows: 0, found: false };
  }

  var templateXml = source.slice(templateRange.start, templateRange.end);
  var list = rows || [];
  var rendered = list.map(function (row) {
    return renderRowTemplate_(templateXml, row, [listName], [marker]);
  }).join('');

  return {
    xml: source.slice(0, templateRange.start) + rendered + source.slice(templateRange.end),
    expandedRows: list.length,
    found: true
  };
}

/**
 * 用途：判斷一個段落是不是它所在表格儲存格（`<w:tc>`）**唯一**的段落。
 *
 *   ⚠️ OOXML 規定每個 `<w:tc>` 至少要有一個 `<w:p>`——如果一個段落範本
 *   （`{{#EACHP:...}}`）剛好落在一個只有它自己一個段落的儲存格內，清單
 *   為空時**不可以把它整個刪掉**，否則那個儲存格會變成零段落，Word 會
 *   判定檔案損毀、要求修復。本專案造範本時就因為刪走表格內段落而踩過
 *   這個坑，見 docs/已知bug類型.md。
 *
 *   判斷方式跟 `mergeRunsInParagraphs_()` 的「最內層擁有者」手法一致：
 *   找出這個段落**最內層**的 `<w:tc>`，再看有多少個段落的最內層擁有者
 *   是同一個 `<w:tc>`——只有一個就代表它是孤兒。
 * Args:
 *   xml {string} 整份 XML。
 *   paragraphRange {{start:number, end:number}} 要判斷的段落範圍。
 * Returns:
 *   {boolean} 不在任何 `<w:tc>` 內（例如在文字方塊或頁首頁尾）一律回 `false`
 *     ——那些地方沒有「至少一個段落」的規定，可以放心整段刪除。
 */
function isSoleParagraphInTableCell_(xml, paragraphRange) {
  var tcRanges = findElementRanges_(xml, 'w:tc');
  var owningTc = innermostRangeContaining_(tcRanges, paragraphRange.start);
  if (!owningTc) return false;

  var paragraphRanges = findElementRanges_(xml, 'w:p');
  var siblingCount = 0;
  paragraphRanges.forEach(function (p) {
    var owner = innermostRangeContaining_(tcRanges, p.start);
    if (owner && owner.start === owningTc.start && owner.end === owningTc.end) siblingCount++;
  });

  return siblingCount === 1;
}

/**
 * 用途：清空一個段落內全部 `<w:t>` 的文字內容，但保留段落／run 的格式
 *   （`<w:pPr>`／`<w:rPr>`）不動。
 *
 *   用於 `expandEachParagraphs_()` 清單為空、而這個段落又是表格儲存格
 *   唯一段落的情況——不能刪段落，只能讓它看起來空白。
 * Args:
 *   paragraphXml {string} 一個完整的 `<w:p>...</w:p>`。
 * Returns:
 *   {string}
 */
function clearParagraphTextKeepingStructure_(paragraphXml) {
  return String(paragraphXml || '').replace(/(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/g, '$1$2');
}

/**
 * 用途：展開一個**段落層**的重複清單（prompt9 §1.1）——與
 *   `expandEachRows_()` 平行，差別是作用的元素是 `<w:p>` 而不是 `<w:tr>`。
 *
 *   一個 `<w:p>` 內若出現 `{{#EACHP:LIST_NAME}}`，該段落就是段落範本：
 *   按清單長度複製整個段落，逐次替換 `{{LIST_NAME.FIELD}}`，移除標記
 *   本身。
 *
 *   ⚠️ **清單為空的處理跟列範本不同**：
 *     - 段落在表格儲存格內、而且是該格**唯一**的段落 → **不可以刪除**
 *       （OOXML 規定每個 `<w:tc>` 至少要有一個 `<w:p>`），改為保留段落
 *       但清空文字（見 `clearParagraphTextKeepingStructure_()`）。
 *     - 其餘情況（不在表格內，或表格儲存格還有其他段落）→ 整個段落刪除，
 *       跟列範本的行為一致。
 * Args:
 *   xml {string} 要處理的 XML。
 *   listName {string} 清單名稱，例如 `'ANNOUNCEMENT'`。
 *   rows {Object[]} 清單資料。
 * Returns:
 *   {{xml:string, expandedRows:number, found:boolean}} `found` 為 false
 *     代表範本內根本沒有這個段落範本。
 */
function expandEachParagraphs_(xml, listName, rows) {
  var source = String(xml || '');
  var marker = '{{#EACHP:' + listName + '}}';
  var markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return { xml: source, expandedRows: 0, found: false };

  var paragraphRanges = findElementRanges_(source, 'w:p');
  var templateRange = innermostRangeContaining_(paragraphRanges, markerIndex);
  if (!templateRange) {
    // 標記不在任何 <w:p> 內（理論上不會發生——XML 的文字節點一定在某個
    // 段落裡）：把標記本身移走，不要留在成品上。
    return { xml: source.split(marker).join(''), expandedRows: 0, found: false };
  }

  var templateXml = source.slice(templateRange.start, templateRange.end);
  var list = rows || [];

  if (list.length === 0) {
    var replacement = isSoleParagraphInTableCell_(source, templateRange)
      ? clearParagraphTextKeepingStructure_(templateXml.split(marker).join(''))
      : '';
    return {
      xml: source.slice(0, templateRange.start) + replacement + source.slice(templateRange.end),
      expandedRows: 0,
      found: true
    };
  }

  var rendered = list.map(function (row) {
    return renderRowTemplate_(templateXml, row, [listName], [marker]);
  }).join('');

  return {
    xml: source.slice(0, templateRange.start) + rendered + source.slice(templateRange.end),
    expandedRows: list.length,
    found: true
  };
}

/**
 * 用途：**交錯**展開兩種列範本（prompt7 §5 的重點，本輪最容易做錯的地方）。
 *
 *   背景：崇拜程序表有兩種列——一般列（項目／內容／立坐三欄）與全寬列
 *   （跨欄置中、沒有立坐，例如「祈禱會」）。而它們在原表中是**交錯**
 *   出現的：「祈禱會」排在「家事報告」之後。
 *
 *   ⚠️ 所以**不可以**分成兩個清單各自展開——那樣全部一般列會排在一起、
 *   全部全寬列排在一起，次序就錯了。正確做法是**一個清單、兩個列範本**：
 *   逐筆按 `fullWidthFlag` 選用對應的列範本，按資料次序輸出。
 *
 *   兩個列範本：`{{#EACH:<listName>}}`（一般列）與
 *   `{{#EACH:<listName>_FW}}`（全寬列）。輸出整批放在**位置較前**的那個
 *   列範本原本的位置，兩個原始列範本都會被刪掉。
 * Args:
 *   xml {string} 要處理的 XML。
 *   listName {string} 清單名稱，例如 `'PROGRAM'`。
 *   rows {Object[]} 清單資料，依顯示次序排好。
 *   fullWidthFlag {string} 每筆資料上代表「這是全寬列」的欄位名稱，
 *     例如 `'IS_FULL_WIDTH'`。
 * Returns:
 *   {{xml:string, expandedRows:number, normalRows:number, fullWidthRows:number,
 *     found:boolean, warnings:{code:string,message:string}[]}}
 *     只找到其中一個列範本時，`warnings` 會記一筆並退回單一列範本模式
 *     （全部資料都用那一個範本），不拋錯——範本可能真的只有一種列。
 */
function expandInterleavedRows_(xml, listName, rows, fullWidthFlag) {
  var source = String(xml || '');
  var normalMarker = '{{#EACH:' + listName + '}}';
  var fullWidthMarker = '{{#EACH:' + listName + '_FW}}';
  var flag = fullWidthFlag || 'IS_FULL_WIDTH';
  var warnings = [];

  // ⚠️ 一定要先找 _FW：`indexOf('{{#EACH:PROGRAM}}')` 不會配到
  // `{{#EACH:PROGRAM_FW}}`（結尾的 `}}` 不同），所以兩者互不干擾，
  // 但先找長的比較不容易在日後改動時出錯。
  var fullWidthIndex = source.indexOf(fullWidthMarker);
  var normalIndex = source.indexOf(normalMarker);

  if (normalIndex === -1 && fullWidthIndex === -1) {
    return { xml: source, expandedRows: 0, normalRows: 0, fullWidthRows: 0, found: false, warnings: warnings };
  }

  var trRanges = findElementRanges_(source, 'w:tr');
  var normalRange = normalIndex === -1 ? null : innermostRangeContaining_(trRanges, normalIndex);
  var fullWidthRange = fullWidthIndex === -1 ? null : innermostRangeContaining_(trRanges, fullWidthIndex);

  if (!normalRange && !fullWidthRange) {
    return {
      xml: source.split(normalMarker).join('').split(fullWidthMarker).join(''),
      expandedRows: 0, normalRows: 0, fullWidthRows: 0, found: false, warnings: warnings
    };
  }

  if (!fullWidthRange) {
    warnings.push({
      code: 'NO_FULL_WIDTH_ROW_TEMPLATE',
      message: '範本只有一般列範本「' + normalMarker + '」，找不到全寬列範本「' + fullWidthMarker
        + '」。全寬列（例如祈禱會）會改用一般列範本輸出，版面可能跟印刷版不同。'
    });
  }
  if (!normalRange) {
    warnings.push({
      code: 'NO_NORMAL_ROW_TEMPLATE',
      message: '範本只有全寬列範本「' + fullWidthMarker + '」，找不到一般列範本「' + normalMarker + '」。'
    });
  }

  var normalXml = normalRange ? source.slice(normalRange.start, normalRange.end) : null;
  var fullWidthXml = fullWidthRange ? source.slice(fullWidthRange.start, fullWidthRange.end) : null;
  var prefixes = [listName, listName + '_FW'];
  var markers = [normalMarker, fullWidthMarker];

  var normalCount = 0;
  var fullWidthCount = 0;
  var list = rows || [];

  var rendered = list.map(function (row) {
    var isFullWidth = Boolean(row && row[flag]);
    var chosen = isFullWidth ? (fullWidthXml || normalXml) : (normalXml || fullWidthXml);
    if (isFullWidth) fullWidthCount++; else normalCount++;
    return renderRowTemplate_(chosen, row, prefixes, markers);
  }).join('');

  // 兩個列範本都刪掉，整批輸出放在位置較前的那一個原本的位置。
  var ranges = [normalRange, fullWidthRange].filter(Boolean)
    .sort(function (a, b) { return a.start - b.start; });

  var edits = ranges.map(function (r, i) {
    return { start: r.start, end: r.end, text: i === 0 ? rendered : '' };
  });

  return {
    xml: applyRangeEdits_(source, edits),
    expandedRows: list.length,
    normalRows: normalCount,
    fullWidthRows: fullWidthCount,
    found: true,
    warnings: warnings
  };
}

// =====================================================================
// 條件列／條件段落
// =====================================================================

/**
 * 用途：判斷一個條件佔位符的值算不算「有值」。
 *
 *   空字串／`null`／`undefined`／`false` 算沒有值；數字 `0` 與字串
 *   `'0'` **算有值**——人數表的「0」是有意義的資料，不可以當成空白刪掉。
 * Args:
 *   value {*}
 * Returns:
 *   {boolean}
 */
function isTruthyForTemplate_(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * 用途：處理條件列 `{{#IF:KEY}}`（規約 2.3）與條件段落 `{{#IFP:KEY}}`
 *   （規約 2.4）的共用實作——兩者只差在作用的元素是 `<w:tr>` 還是 `<w:p>`。
 * Args:
 *   xml {string} 要處理的 XML。
 *   values {Object<string,*>} 佔位符 → 值。
 *   markerPrefix {string} `'{{#IF:'` 或 `'{{#IFP:'`。
 *   tag {string} `'w:tr'` 或 `'w:p'`。
 * Returns:
 *   {{xml:string, removed:number, kept:number}}
 */
function applyConditionalElements_(xml, values, markerPrefix, tag) {
  var source = String(xml || '');
  var lookup = values || {};
  var pattern = new RegExp(markerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([A-Z0-9_]+)\\}\\}', 'g');

  var hits = [];
  var m;
  while ((m = pattern.exec(source)) !== null) {
    hits.push({ index: m.index, whole: m[0], key: m[1] });
  }
  if (hits.length === 0) return { xml: source, removed: 0, kept: 0 };

  var ranges = findElementRanges_(source, tag);
  var edits = [];
  var removed = 0;
  var kept = 0;
  var handledRanges = {};

  hits.forEach(function (hit) {
    var owner = innermostRangeContaining_(ranges, hit.index);
    if (!owner) {
      // 標記不在任何目標元素內：只把標記本身移走。
      edits.push({ start: hit.index, end: hit.index + hit.whole.length, text: '' });
      return;
    }

    var rangeKey = owner.start + ':' + owner.end;
    if (handledRanges[rangeKey]) return; // 同一列有多個標記：第一個決定去留
    handledRanges[rangeKey] = true;

    if (isTruthyForTemplate_(lookup[hit.key])) {
      kept++;
      var elementXml = source.slice(owner.start, owner.end);
      edits.push({ start: owner.start, end: owner.end, text: elementXml.split(hit.whole).join('') });
    } else {
      removed++;
      edits.push({ start: owner.start, end: owner.end, text: '' });
    }
  });

  return { xml: applyRangeEdits_(source, edits), removed: removed, kept: kept };
}

/**
 * 用途：處理條件列 `{{#IF:KEY}}`（規約 2.3）——值為空就整列刪除，
 *   否則保留並移除標記本身。
 * Args:
 *   xml {string} 要處理的 XML。
 *   values {Object<string,*>} 佔位符 → 值。
 * Returns:
 *   {{xml:string, removed:number, kept:number}}
 */
function applyConditionalRows_(xml, values) {
  return applyConditionalElements_(xml, values, '{{#IF:', 'w:tr');
}

/**
 * 用途：處理條件段落 `{{#IFP:KEY}}`（規約 2.4）——規則同條件列，
 *   但作用於 `<w:p>`。
 *
 *   ⚠️ 段落版本是必要的：週報有大量內容不在表格內（文字方塊裡的獻花、
 *   本週讀經），那些地方沒有 `<w:tr>` 可以刪。
 * Args:
 *   xml {string} 要處理的 XML。
 *   values {Object<string,*>} 佔位符 → 值。
 * Returns:
 *   {{xml:string, removed:number, kept:number}}
 */
function applyConditionalParagraphs_(xml, values) {
  return applyConditionalElements_(xml, values, '{{#IFP:', 'w:p');
}

// =====================================================================
// 「標籤與佔位符同屬一格」的選填副框
// =====================================================================

/**
 * 用途：清空一個表格儲存格內全部 `<w:t>` 的文字，但保留儲存格／段落／
 *   run 的結構與格式。
 *
 *   ⚠️ 一定要**保留結構**：OOXML 規定每個 `<w:tc>` 至少要有一個 `<w:p>`，
 *   把段落刪光會令 Word 判定檔案損毀、開啟時要求修復（見
 *   docs/已知bug類型.md 事故十六）。
 * Args:
 *   cellXml {string} 一個完整的 `<w:tc>...</w:tc>`。
 * Returns:
 *   {string}
 */
function clearCellTextKeepingStructure_(cellXml) {
  return clearParagraphTextKeepingStructure_(String(cellXml || ''));
}

/**
 * 用途：處理「標籤與佔位符寫在**同一格**」的選填副框——浸禮合堂範本第 1
 *   頁那個 3 列 × 2 欄的表格就是這一種。
 *
 *   ─────────────────────────────────────────────────────────────────
 *   為什麼不能用 `{{#IF:}}` 條件列解決
 *   ─────────────────────────────────────────────────────────────────
 *
 *   副框每一格的文字是「`浸禮：{{BAPTISM_OFFICIANT}}`」——**標籤是範本上
 *   的死字，不是佔位符**。單純把佔位符換成空字串，紙上就會剩下一個孤零零
 *   的「浸禮：」，比空白更難看。所以留空時要把**整格文字**清掉，連標籤
 *   一併清走。條件列 `{{#IF:}}` 只能整列去留，做不到「同一列一格保留、
 *   另一格連標籤清空」，而且範本上根本沒有那些標記（範本已定稿，不改）。
 *
 *   三條規則（`rowGroups` 每個元素是一列的兩個機器鍵）：
 *     1. 同一列**全部**欄位皆空 → **刪除整列**（標籤不可以孤零零留下）。
 *     2. **全部**列都要刪、而且那個表格內沒有其他列 → **刪除整個表格**
 *        （留一個空表格在紙上同樣難看；而且空表格容易踩中事故十六）。
 *     3. 同一列只有部分欄位有值 → 該列保留，**空的那格連標籤一併清空**。
 *
 *   範本上找不到的機器鍵一律略過（例如平常主日範本根本沒有這個副框），
 *   整份 XML 原樣回傳，不拋錯——同一套渲染流程要能跑三個不同的範本。
 * Args:
 *   xml {string} 要處理的 XML（建議已經跑過 `mergeRunsInParagraphs_()`，
 *     否則被 Word 拆散的佔位符找不到）。
 *   values {Object<string,*>} 佔位符 → 值。判斷「有沒有值」用
 *     `isTruthyForTemplate_()`，與條件列同一套標準。
 *   rowGroups {string[][]} 每個元素是一列，內含該列各格的機器鍵。
 *     例如 `baptismBoxRowGroups_()`（`src/BaptismBox.gs`）。
 * Returns:
 *   {{xml:string, removedRows:number, clearedCells:number,
 *     removedTables:number, found:boolean}} `found` 為 false 代表範本內
 *     完全沒有這些佔位符（不是錯誤）。
 */
function applyOptionalLabelledCellRows_(xml, values, rowGroups) {
  var source = String(xml || '');
  var lookup = values || {};
  var groups = rowGroups || [];
  if (groups.length === 0) {
    return { xml: source, removedRows: 0, clearedCells: 0, removedTables: 0, found: false };
  }

  var tcRanges = findElementRanges_(source, 'w:tc');
  var trRanges = findElementRanges_(source, 'w:tr');
  var tblRanges = findElementRanges_(source, 'w:tbl');

  // ---- 逐列盤點：這一列有哪些格在範本內、各自空不空 ----
  var plans = [];
  groups.forEach(function (keys) {
    var cells = [];
    (keys || []).forEach(function (key) {
      var placeholder = '{{' + key + '}}';
      var at = source.indexOf(placeholder);
      if (at === -1) return; // 這個範本沒有這一格，略過
      var owningTc = innermostRangeContaining_(tcRanges, at);
      if (!owningTc) return; // 佔位符不在表格內：不屬於本函式處理的形態
      cells.push({ key: key, at: at, tc: owningTc, filled: isTruthyForTemplate_(lookup[key]) });
    });
    if (cells.length === 0) return;

    var owningTr = innermostRangeContaining_(trRanges, cells[0].at);
    if (!owningTr) return;

    plans.push({
      tr: owningTr,
      tbl: innermostRangeContaining_(tblRanges, cells[0].at),
      cells: cells,
      allEmpty: cells.every(function (c) { return !c.filled; })
    });
  });

  if (plans.length === 0) {
    return { xml: source, removedRows: 0, clearedCells: 0, removedTables: 0, found: false };
  }

  // ---- 規則 2：全部列都要刪，而且那個表格沒有其他列 → 整個表格刪掉 ----
  if (plans.every(function (p) { return p.allEmpty; })) {
    var firstTbl = plans[0].tbl;
    var sameTable = firstTbl && plans.every(function (p) {
      return p.tbl && p.tbl.start === firstTbl.start && p.tbl.end === firstTbl.end;
    });
    if (sameTable) {
      // 只有「這個表格裡的列全部都在 plans 內」才可以整個刪——表格內若還有
      // 其他列（例如標題列），整個刪會連那些一併丟掉。
      var rowsInTable = trRanges.filter(function (r) {
        return r.start >= firstTbl.start && r.end <= firstTbl.end;
      });
      if (rowsInTable.length === plans.length) {
        return {
          xml: applyRangeEdits_(source, [{ start: firstTbl.start, end: firstTbl.end, text: '' }]),
          removedRows: 0,
          clearedCells: 0,
          removedTables: 1,
          found: true
        };
      }
    }
  }

  // ---- 規則 1 與 3：逐列處理 ----
  var edits = [];
  var removedRows = 0;
  var clearedCells = 0;

  plans.forEach(function (p) {
    if (p.allEmpty) {
      removedRows++;
      edits.push({ start: p.tr.start, end: p.tr.end, text: '' });
      return;
    }
    p.cells.forEach(function (c) {
      if (c.filled) return;
      clearedCells++;
      edits.push({
        start: c.tc.start,
        end: c.tc.end,
        text: clearCellTextKeepingStructure_(source.slice(c.tc.start, c.tc.end))
      });
    });
  });

  return {
    xml: applyRangeEdits_(source, edits),
    removedRows: removedRows,
    clearedCells: clearedCells,
    removedTables: 0,
    found: true
  };
}

// =====================================================================
// 總入口
// =====================================================================

/**
 * 用途：把整份 `word/document.xml` 渲染成填好資料的版本。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 執行次序（次序錯會出事，改動這個函式之前先讀完這一段）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   1. `mergeRunsInParagraphs_`　合併被 Word 拆散的 run。**不做這一步，
 *      後面全部替換都會靜靜失敗**（見檔頭）。
 *   2. `findBrokenPlaceholders_`　收集成 warning，**不中斷**——一個壞掉
 *      的佔位符不應該讓整份週報生不出來，但一定要講出來。
 *   3. `expandInterleavedRows_` → `expandEachRows_` → `expandEachParagraphs_`
 *      　依序展開重複列／段落（同一個清單名稱三者互斥，落在哪一種由範本
 *      實際用的標記決定：交錯用的兩個 `{{#EACH:LIST}}`／`{{#EACH:LIST_FW}}`、
 *      單純列範本用 `{{#EACH:LIST}}`、段落範本用 `{{#EACHP:LIST}}`）。
 *      **⚠️ 一定要排在單值替換之前**：列／段範本內的 `{{PROGRAM.ITEM}}`
 *      雖然不會被單值替換碰到（單值只認不含點的鍵），但範本內也可能有
 *      `{{CHURCH_NAME}}` 這類單值佔位符；先替換單值的話，那個值只會被
 *      填一次，複製出來的每一份就都是同一份，而且 `{{#EACH:}}`／
 *      `{{#EACHP:}}` 標記還在原地。tests/docxtemplate.test.js 有一個測試
 *      專門鎖住這個次序。
 *   4. `applyConditionalRows_` / `applyConditionalParagraphs_`　條件去留。
 *      排在展開之後，才能對「展開出來的列／段」也生效。
 *   4b. `applyOptionalLabelledCellRows_`　選填副框（標籤與佔位符同格）。
 *      **一定要排在單值替換之前**：留空的那一格要連標籤一併清走，如果
 *      先做單值替換，佔位符已經變成空字串，就分不出「這一格本來有沒有
 *      值」，紙上會剩下孤零零的標籤。
 *   5. `replaceSimplePlaceholders_`　最後才替換單值。
 *
 * Args:
 *   xml {string} `word/document.xml` 的原始內容。
 *   context {{values:Object, lists:Object, missingValueMode:(string|undefined),
 *            interleavedLists:(Object<string,string>|undefined),
 *            optionalCellRows:(string[][]|undefined)}}
 *     `values` 是單值佔位符表；`lists` 是清單名稱 → 資料陣列；
 *     `missingValueMode` 見 `replaceSimplePlaceholders_()`；
 *     `interleavedLists` 是「清單名稱 → 全寬旗標欄位名」，列在裡面的
 *     清單會走交錯展開（例如 `{ PROGRAM: 'IS_FULL_WIDTH' }`）；
 *     `optionalCellRows` 是選填副框的列分組，見
 *     `applyOptionalLabelledCellRows_()`。
 * Returns:
 *   {{xml:string, stats:{replacedCount:number, expandedRows:number,
 *     removedRows:number, removedParagraphs:number, clearedCells:number,
 *     removedTables:number, missingKeys:string[],
 *     broken:Object[], lists:Object<string,number>},
 *     warnings:{code:string,message:string}[]}}
 * Raises:
 *   Error 當 `missingValueMode` 是 `'ERROR'` 而且有佔位符找不到值。
 */
function renderDocumentXml_(xml, context) {
  var ctx = context || {};
  var values = ctx.values || {};
  var lists = ctx.lists || {};
  var interleaved = ctx.interleavedLists || {};
  var warnings = [];

  // ---- 1. 合併被拆散的 run ----
  var working = mergeRunsInParagraphs_(String(xml || ''));

  // ---- 2. 偵測被切斷的佔位符（只報告，不中斷）----
  var broken = findBrokenPlaceholders_(working);
  broken.forEach(function (b) {
    warnings.push({
      code: 'BROKEN_PLACEHOLDER',
      message: '疑似被切斷的佔位符（第 ' + (b.paragraphIndex + 1) + ' 段，' + b.kind + '）：'
        + b.text + '　這個佔位符不會被替換，會原樣印在成品上。'
        + '修法：在 Word 把它整段刪掉重新打一次，見 docs/Word範本製作指引.md。'
    });
  });

  // ---- 3. 展開重複列（一定要在單值替換之前）----
  var expandedRows = 0;
  var listStats = {};

  Object.keys(lists).forEach(function (listName) {
    var rows = lists[listName] || [];
    if (Object.prototype.hasOwnProperty.call(interleaved, listName)) {
      var interleavedResult = expandInterleavedRows_(working, listName, rows, interleaved[listName]);
      working = interleavedResult.xml;
      expandedRows += interleavedResult.expandedRows;
      listStats[listName] = interleavedResult.expandedRows;
      (interleavedResult.warnings || []).forEach(function (w) { warnings.push(w); });
      return;
    }

    // 同一個清單名稱，範本可能用列範本（{{#EACH:}}）或段落範本
    // （{{#EACHP:}}）——兩種標記字串不同，互不干擾，找不到自己的標記時
    // 各自回 found:false、xml 原樣不動，所以兩個都跑一次是安全的。
    var rowResult = expandEachRows_(working, listName, rows);
    working = rowResult.xml;

    var paragraphResult = expandEachParagraphs_(working, listName, rows);
    working = paragraphResult.xml;

    var expandedForList = rowResult.expandedRows + paragraphResult.expandedRows;
    expandedRows += expandedForList;
    listStats[listName] = expandedForList;
  });

  // ---- 4. 條件列與條件段落 ----
  var condRows = applyConditionalRows_(working, values);
  working = condRows.xml;
  var condParagraphs = applyConditionalParagraphs_(working, values);
  working = condParagraphs.xml;

  // ---- 4b. 選填副框（標籤與佔位符同格，一定要在單值替換之前）----
  var optionalCells = applyOptionalLabelledCellRows_(working, values, ctx.optionalCellRows || []);
  working = optionalCells.xml;

  // ---- 5. 單值替換（最後）----
  var simple = replaceSimplePlaceholders_(working, values, ctx.missingValueMode || 'BLANK');
  working = simple.xml;

  simple.missingKeys.forEach(function (key) {
    warnings.push({
      code: 'PLACEHOLDER_VALUE_MISSING',
      message: '範本用到佔位符「{{' + key + '}}」，但系統沒有提供這個值。'
        + '（目前的處理方式由 Config 的 TEMPLATE_MISSING_VALUE_MODE 決定。）'
    });
  });

  return {
    xml: working,
    stats: {
      replacedCount: simple.replacedCount,
      expandedRows: expandedRows,
      removedRows: condRows.removed + optionalCells.removedRows,
      removedParagraphs: condParagraphs.removed,
      clearedCells: optionalCells.clearedCells,
      removedTables: optionalCells.removedTables,
      missingKeys: simple.missingKeys,
      broken: broken,
      lists: listStats
    },
    warnings: warnings
  };
}
