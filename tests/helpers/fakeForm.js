#!/usr/bin/env node
/**
 * tests/helpers/fakeForm.js
 *
 * 最小的假 `FormApp` 與表單提交事件，供講員表格（階段 3）的測試使用。
 *
 * ⚠️ 只模仿本專案用得到的那一小部分：
 *   - `FormApp.create()`／`openById()`；
 *   - 表單設定（`setRequireLogin()` 等）與題目（下拉、短答、段落）；
 *   - 表單提交事件 `e.response`（`getRespondentEmail()`、`getTimestamp()`、
 *     `getItemResponses()`）。
 * 設定值記在表單物件的 `__settings`，讓測試驗得到「真的設成只限教會帳戶」。
 */

'use strict';

/**
 * 用途：造一個假的 `FormApp`。
 * Args:
 *   options {{failOpen:boolean=, failCreate:boolean=}=} `failOpen`：`openById()` 一律拋錯
 *     （模擬表單被刪或 forms 範圍未授權）；`failCreate`：`create()` 一律拋錯。
 * Returns:
 *   {{FormApp:Object, forms:Object[], setOption:function(string,*):void}}
 */
function makeFakeFormApp(options) {
  const opts = Object.assign({}, options || {});
  const forms = [];

  function makeItem(type, form) {
    const item = {
      __type: type, __title: '', __choices: [], __required: false,
      setTitle: function (t) { item.__title = t; return item; },
      getTitle: function () { return item.__title; },
      setRequired: function (b) { item.__required = b; return item; },
      setChoiceValues: function (values) {
        if (!values || values.length === 0) throw new Error('假的 ListItem：不可以沒有選項');
        item.__choices = values.slice();
        return item;
      },
      getChoices: function () {
        return item.__choices.map(function (v) { return { getValue: function () { return v; } }; });
      },
      asListItem: function () { return item; }
    };
    form.__items.push(item);
    return item;
  }

  function makeForm(title) {
    const id = 'FAKE_FORM_' + (forms.length + 1);
    const form = {
      __id: id, __title: title, __items: [],
      __settings: {
        requireLogin: false, emailCollectionType: 'DO_NOT_COLLECT', limitOne: true,
        publishingSummary: true, showLinkToRespondAgain: true, allowResponseEdits: false,
        description: '', confirmation: '',
        // 內容表 v2：「停用舊功能」關閉收件（setAcceptingResponses(false)＋停止訊息）。
        acceptingResponses: true, closedMessage: ''
      },
      isAcceptingResponses: function () { return form.__settings.acceptingResponses; },
      setAcceptingResponses: function (b) { form.__settings.acceptingResponses = b === true; return form; },
      setCustomClosedFormMessage: function (t) { form.__settings.closedMessage = String(t); return form; },
      getCustomClosedFormMessage: function () { return form.__settings.closedMessage; },
      setDescription: function (t) { form.__settings.description = t; return form; },
      setConfirmationMessage: function (t) { form.__settings.confirmation = t; return form; },
      setRequireLogin: function (b) { form.__settings.requireLogin = b; return form; },
      requiresLogin: function () { return form.__settings.requireLogin; },
      setEmailCollectionType: function (t) { form.__settings.emailCollectionType = t; return form; },
      getEmailCollectionType: function () { return form.__settings.emailCollectionType; },
      setLimitOneResponsePerUser: function (b) { form.__settings.limitOne = b; return form; },
      setPublishingSummary: function (b) { form.__settings.publishingSummary = b; return form; },
      setShowLinkToRespondAgain: function (b) { form.__settings.showLinkToRespondAgain = b; return form; },
      setAllowResponseEdits: function (b) { form.__settings.allowResponseEdits = b; return form; },
      addListItem: function () { return makeItem('LIST', form); },
      addTextItem: function () { return makeItem('TEXT', form); },
      addParagraphTextItem: function () { return makeItem('PARAGRAPH_TEXT', form); },
      getItems: function (type) {
        return form.__items.filter(function (i) { return !type || i.__type === type; });
      },
      getId: function () { return id; },
      getPublishedUrl: function () { return 'https://docs.google.com/forms/d/e/' + id + '/viewform'; },
      getEditUrl: function () { return 'https://docs.google.com/forms/d/' + id + '/edit'; }
    };
    forms.push(form);
    return form;
  }

  const FormApp = {
    ItemType: { LIST: 'LIST', TEXT: 'TEXT', PARAGRAPH_TEXT: 'PARAGRAPH_TEXT' },
    EmailCollectionType: { DO_NOT_COLLECT: 'DO_NOT_COLLECT', VERIFIED: 'VERIFIED', RESPONDER_INPUT: 'RESPONDER_INPUT' },
    create: function (title) {
      if (opts.failCreate) throw new Error('假的 FormApp.create 失敗（forms 範圍未授權）');
      return makeForm(title);
    },
    openById: function (id) {
      if (opts.failOpen) throw new Error('假的 FormApp.openById 失敗');
      const found = forms.filter(function (f) { return f.__id === id; })[0];
      if (!found) throw new Error('找不到表單：' + id);
      return found;
    }
  };

  return { FormApp: FormApp, forms: forms, setOption: function (k, v) { opts[k] = v; } };
}

/**
 * 用途：造一個表單提交事件。
 * Args:
 *   answersByTitle {Object<string,string>} 題目字眼 → 答案文字。
 *   meta {{email:string=, timestamp:Date=}=}
 * Returns:
 *   {{response:Object}}
 */
function makeFormSubmitEvent(answersByTitle, meta) {
  const m = meta || {};
  return {
    response: {
      getRespondentEmail: function () { return m.email === undefined ? 'speaker@church.example' : m.email; },
      getTimestamp: function () { return m.timestamp || new Date(); },
      getItemResponses: function () {
        return Object.keys(answersByTitle).map(function (title) {
          return {
            getItem: function () { return { getTitle: function () { return title; } }; },
            getResponse: function () { return answersByTitle[title]; }
          };
        });
      }
    }
  };
}

module.exports = { makeFakeFormApp: makeFakeFormApp, makeFormSubmitEvent: makeFormSubmitEvent };
