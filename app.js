import {
  store,
  today,
  uid,
  escape as e,
  readConfig,
  saveConfig,
} from "./js/store.js";
import {
  fields,
  guess,
  convert,
  readExcel,
  workbook,
  saveWorkbook,
  styleSheet,
  quoteWorkbook,
  reportWorkbook,
  categories,
  reportHeaders,
  reportValues,
  md,
} from "./js/excel.js";
const $ = (s) => document.querySelector(s),
  main = $("#main");
const state = {
  page: "orders",
  date: today(),
  filter: "all",
  group: "all",
  search: "",
  view: "grid",
  report: "abnormal",
  fixedOnly: false,
  warnCodes: null,
  warnOnly: false,
  quoteMode: "有貨號",
  stage: "all",
  selected: new Set(),
  quoteCustomer: null,
  historyBefore: null,
  historyPages: [null],
  historyRows: null,
  reportBefore: null,
  reportPages: [null],
  editReport: null,
  addReportDraft: {},
  quoteCycle: "all",
  quoteUnit: "all",
};
const labels = {
  orders: "每日打勾單",
  reports: "異常與交接",
  quotes: "報價單管理",
  customers: "客戶與車輛",
  history: "歷史紀錄",
  settings: "系統設定",
};
let modalRecord = null,
  wizard = null,
  toastTimer,
  renderQueued = false;
const customers = () =>
  store
    .list("customers", (c) => c.active !== false)
    .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));
const orders = () => store.list("orders", (r) => r.date === state.date);
const order = (c) => orders().find((o) => o.customer_code === c.code);
const status = (c) => order(c)?.status || "pending";
const profiles = () => store.list("profiles");
const profile = (c) =>
  profiles().find((p) => p.customer_code === c.code) || {
    id: c.code,
    revision: 0,
    customer_code: c.code,
    mode: "有貨號",
    cycle: 7,
    mapping: null,
    item_count: 0,
  };
const due = (c) => {
  const p = profile(c);
  return p.last_export_time
    ? new Date(
        new Date(p.last_export_time).getTime() +
          Number(p.cycle || 7) * 86400000,
      )
        .toISOString()
        .slice(0, 10)
    : null;
};
const quoteMatch = (c) =>
  (c.name.includes(state.search) || c.code.includes(state.search)) &&
  (state.quoteCycle === "all" ||
    String(profile(c).cycle) === state.quoteCycle) &&
  (state.quoteUnit === "all" ||
    (profile(c).unit || "unset") === state.quoteUnit);
const stage = (c) =>
  !profile(c).mapping ? "setup" : !profile(c).item_count ? "upload" : "ready";
const time = (s) =>
  s
    ? new Date(s).toLocaleTimeString("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Taipei",
      })
    : "—";
const dateShort = (s) =>
  s
    ? new Date(s).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })
    : "—";
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 4000);
}
async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message);
    console.error(err);
    return null;
  }
}
function icon(text, cls = "") {
  return `<span class="stat-icon ${cls}" aria-hidden="true">${text}</span>`;
}
function heading(title, subtitle, actions = "") {
  return `<div class="page-heading"><div><span class="eyebrow">CHUNGHSIN · DAILY OPERATIONS</span><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`;
}
const dateInput = () =>
  `<label class="date-control"><span aria-hidden="true">▦</span><input type="date" aria-label="作業日期" id="workDate" value="${state.date}" required><span class="subtle">⌄</span></label>`;
function empty(title, sub, action = "") {
  return `<div class="empty"><span class="empty-icon">🌱</span><h3>${title}</h3><p>${sub}</p>${action}</div>`;
}
function stat(label, n, total, sign, color, note) {
  return `<article class="stat ${color}"><div class="stat-top">${label}${icon(sign)}</div><div class="stat-number">${n}<small>${label.includes("率") ? "%" : "位"}</small></div><div class="stat-bottom"><span>${note}</span><b>${total ? Math.round((n / total) * 100) + "%" : ""}</b></div><div class="progress"><span style="width:${total ? Math.min(100, (n / total) * 100) : 0}%"></span></div></article>`;
}
function orderPage() {
  const cs = customers(),
    done = cs.filter((c) => status(c) === "ordered").length,
    pending = cs.filter((c) => status(c) === "pending").length,
    off = cs.length - done - pending;
  const groups = [...new Set(cs.map((c) => c.group || "未分類"))];
  const filtered = cs.filter(
    (c) =>
      (!state.fixedOnly || c.fixed) &&
      (!state.warnOnly || state.warnCodes?.includes(c.code)) &&
      (state.filter === "all" || status(c) === state.filter) &&
      (state.group === "all" || (c.group || "未分類") === state.group) &&
      [c.name, c.code, c.car_no, c.notes]
        .join(" ")
        .toLowerCase()
        .includes(state.search.toLowerCase()),
  );
  return (
    heading(
      "每日打勾單",
      "從一聲早安開始，讓今天的每一筆訂單都井然有序。",
      dateInput() +
        `<button class="btn primary" data-action="add-customer">＋ 新增客戶</button>`,
    ) +
    `<section class="welcome"><div class="welcome-copy"><h2>新鮮的一天，準備好了嗎？ <span aria-hidden="true">☀</span></h2><p>今天還有 <strong>${pending}</strong> 位客戶待確認叫貨，一起把新鮮送到位。</p><div class="welcome-note"><i></i>${state.date === today() ? "今日" : "所選日期"}作業總覽 <span>・</span> ${cs.length ? Math.round((done / cs.length) * 100) : 0}% 已完成</div></div><div class="hero-art" aria-hidden="true"><div class="orbit"></div><span class="veg broccoli">🥦</span><span class="veg carrot">🥕</span><span class="veg tomato">🍅</span><span class="spark">✧</span><span class="spark two">✦</span></div></section><section class="stats" aria-label="叫貨統計">${stat("客戶總數", cs.length, 0, "♧", "", "所有啟用中的客戶")}${stat("已叫貨", done, cs.length, "✓", "green", "今日已確認叫貨")}${stat("待叫貨", pending, cs.length, "◷", "orange", "等待確認的客戶")}${stat("今日不叫貨", off, cs.length, "−", "blue", "已確認暫不叫貨")}</section><div class="work-layout"><section class="panel"><div class="section-title"><h2>客戶叫貨狀態<span>DAILY CHECKLIST</span></h2><button class="text-link" data-action="order-export">↓ 匯出紀錄</button></div><div class="toolbar"><div class="segments">${[
      ["all", "全部", cs.length],
      ["pending", "待叫貨", pending],
      ["ordered", "已叫貨", done],
      ["off", "不叫貨", off],
    ]
      .map(
        ([v, l, n]) =>
          `<button data-filter="${v}" class="${state.filter === v ? "active" : ""}" aria-pressed="${state.filter === v}">${l}<b>${n}</b></button>`,
      )
      .join(
        "",
      )}</div><label class="search">⌕ <input id="search" placeholder="搜尋客戶名稱、代號…" aria-label="搜尋客戶" value="${e(state.search)}"></label></div><div class="filter-row"><button class="chip ${state.group === "all" ? "active" : ""}" data-group="all">全部系列</button>${groups.map((g) => `<button class="chip ${state.group === g ? "active" : ""}" data-group="${e(g)}">${e(g)} ${cs.filter((c) => (c.group || "未分類") === g && status(c) === "ordered").length}/${cs.filter((c) => (c.group || "未分類") === g).length}</button>`).join("")}<button class="chip ${state.fixedOnly ? "active" : ""}" data-action="fixed-filter">固定叫貨</button><button class="chip ${state.warnOnly ? "active" : ""}" data-action="warn-filter">三天未叫</button><div class="view-switch"><button data-view="grid" class="${state.view === "grid" ? "active" : ""}" aria-label="卡片檢視">▦</button><button data-view="list" class="${state.view === "list" ? "active" : ""}" aria-label="清單檢視">☷</button></div></div><div class="customer-grid ${state.view === "list" ? "list-mode" : ""}">${filtered.length ? filtered.map(customerCard).join("") : empty(cs.length ? "找不到符合的客戶" : "讓今天的工作，從第一位客戶開始", cs.length ? "試試其他關鍵字或系列。" : "新增客戶，或先載入範例體驗操作。", cs.length ? "" : `<button class="btn primary" data-action="demo">載入示範資料</button>`)}</div><div class="panel-footer"><span>顯示 ${filtered.length} / ${cs.length} 位客戶</span><span>✓ 點擊勾選即確認叫貨 · 點 ⋯ 編輯狀態</span></div></section><aside class="right-rail">${noticePanel()}${activityPanel()}<div class="tip-card"><h3>✧ 工作小提醒</h3><p>點擊客戶卡片右上方的勾選框，<br>即可確認叫貨。更改狀態請使用 ⋯。</p></div></aside></div>`
  );
}
function customerCard(c) {
  const s = status(c),
    o = order(c);
  return `<article class="customer-card ${s === "ordered" ? "ordered" : s === "off" ? "absent" : ""}"><div class="customer-top"><span class="customer-code">${e(c.code)}</span><button class="order-check ${s === "ordered" ? "done" : ""}" data-check="${e(c.code)}" aria-label="${e(c.name)}${s === "ordered" ? "已叫貨，編輯狀態" : "確認叫貨"}" aria-pressed="${s === "ordered"}">${s === "ordered" ? "✓" : s === "off" ? "−" : ""}</button></div><h3 title="${e(c.name)}">${e(c.name)}</h3><div class="customer-meta"><span class="car">${e(c.car_no || "未配車")}</span><span>·</span><span>${e(c.group || "未分類")}${c.fixed ? " · 固定" : ""}</span></div><div class="customer-bottom"><span>${s === "ordered" ? "✓ 已叫貨　" + time(o?.at) : s === "off" ? "− 今日不叫貨" : "◷ 等待叫貨"}</span><button class="edit-dots" data-edit-order="${e(c.code)}" aria-label="編輯 ${e(c.name)} 狀態">⋯</button></div></article>`;
}
function noticePanel() {
  const notes = store
    .list("notices")
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
    .slice(0, 3);
  return `<section class="panel"><div class="rail-heading"><span>♧</span>今日公告<button class="icon-btn" data-action="notice" aria-label="新增公告">＋</button></div>${notes.length ? notes.map((n, i) => `<article class="notice ${i % 2 ? "purple" : ""}"><div class="notice-title">${i % 2 ? "✦" : "▱"} ${e(n.title)}</div><p>${e(n.text)}</p><small>${dateShort(n.at)} · ${time(n.at)} <button class="text-link" data-delete-notice="${n.id}" aria-label="刪除公告">×</button></small></article>`).join("") : '<p class="subtle">目前沒有公告，點 ＋ 新增工作提醒。</p>'}<div class="rail-footer">把重要的事，留給每一位夥伴。</div></section>`;
}
function activityPanel() {
  const os = orders()
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
    .slice(0, 4);
  return `<section class="panel"><div class="rail-heading"><span>◷</span>最近動態</div>${os.length ? os.map((o) => `<div class="activity"><span class="activity-dot ${o.status === "ordered" ? "" : "purple"}"></span><div><strong>${e(customers().find((c) => c.code === o.customer_code)?.name || o.customer_code)}</strong><br>${o.status === "ordered" ? "已確認叫貨" : o.status === "off" ? "已設為不叫貨" : "已改為待叫貨"}<small>${time(o.at)}</small></div></div>`).join("") : '<p class="subtle">完成第一筆叫貨後，這裡會顯示最新動態。</p>'}<button class="text-link" data-action="history">查看歷史紀錄 →</button></section>`;
}
const field = (label, name, value = "", type = "text", extra = "") =>
  `<label class="field ${extra.includes("data-full") ? "full" : ""}">${label}<input name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
const select = (label, name, options, value = "", extra = "") =>
  `<label class="field">${label}<select name="${name}" ${extra}>${options.map((x) => `<option value="${e(Array.isArray(x) ? x[0] : x)}" ${(Array.isArray(x) ? x[0] : x) === value ? "selected" : ""}>${e(Array.isArray(x) ? x[1] : x)}</option>`).join("")}</select></label>`;
const area = (label, name, value = "", extra = "") =>
  `<label class="field full">${label}<textarea name="${name}" ${extra}>${e(value)}</textarea></label>`;
function openModal(title, body, wide = false) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = body;
  $("#modal").classList.toggle("wide", wide);
  $("#modal").classList.remove("printing");
  if (!$("#modal").open) $("#modal").showModal();
}
function closeModal() {
  if (wizard?.dirty && !confirm("尚未儲存的匯入內容將不保留，確定關閉？"))
    return;
  wizard = null;
  modalRecord = null;
  $("#modal").classList.remove("printing");
  $("#modal").close();
}
const formButtons = (text = "儲存") =>
  `<div class="form-actions"><button type="button" class="btn" data-action="close-modal">取消</button><button type="submit" class="btn primary">${text}</button></div>`;
function editCustomer(code) {
  const c = customers().find((c) => c.code === code) || {};
  modalRecord = {
    kind: "customers",
    id: c.id || null,
    revision: c.revision || 0,
  };
  openModal(
    c.id ? "編輯客戶" : "新增客戶",
    `<form id="customerForm"><div class="form-grid">${field("客戶代號 *", "code", c.code || "", "text", `required maxlength="50" ${c.id ? "readonly" : ""}`)}${field("客戶名稱 *", "name", c.name || "", "text", 'required maxlength="150"')}${field("客戶系列", "group", c.group || "", "text", 'list="groupNames" maxlength="100"')}${field("配送車號", "car_no", c.car_no || "", "text", 'list="carNames" maxlength="30"')}${select(
      "是否固定叫貨",
      "fixed",
      [
        ["no", "一般客戶"],
        ["yes", "固定叫貨"],
      ],
      c.fixed ? "yes" : "no",
    )}${select(
      "客戶狀態",
      "active",
      [
        ["yes", "啟用"],
        ["no", "停用"],
      ],
      c.active === false ? "no" : "yes",
    )}${area("備註", "notes", c.notes || "", 'maxlength="2000"')}</div><datalist id="groupNames">${[...new Set(customers().map((c) => c.group))].map((g) => `<option value="${e(g)}">`).join("")}</datalist><datalist id="carNames">${store
      .list("vehicles")
      .map((v) => `<option value="${e(v.car_no)}">`)
      .join("")}</datalist>${formButtons()}</form>`,
  );
}
function editOrder(code) {
  const c = customers().find((c) => c.code === code),
    o = order(c);
  modalRecord = {
    kind: "orders",
    id: `${state.date}:${code}`,
    revision: o?.revision || 0,
  };
  openModal(
    "編輯叫貨狀態",
    `<form id="orderForm" data-code="${e(code)}"><div class="form-note">${e(c.name)} · ${state.date}<br>已叫貨改回待叫貨，需在此確認後儲存。</div>${select(
      "叫貨狀態",
      "status",
      [
        ["pending", "待叫貨"],
        ["ordered", "已叫貨"],
        ["off", "今日不叫貨"],
      ],
      o?.status || "pending",
    )}${formButtons()}</form>`,
  );
}
async function changeOrder(code, next = "ordered", expected) {
  const c = customers().find((c) => c.code === code),
    o = order(c);
  if (expected === undefined && status(c) !== "pending") return editOrder(code);
  await store.mutate(
    "orders",
    `${state.date}:${code}`,
    {
      customer_code: code,
      date: state.date,
      status: next,
      fixed: c.fixed,
      at: new Date().toISOString(),
    },
    { revision: expected ?? o?.revision ?? 0 },
  );
  if (expected !== undefined) closeModal();
  toast(store.cloud ? "叫貨狀態已同步" : "叫貨狀態已儲存在本機");
}
function reportForm(r = {}) {
  const ab = state.report === "abnormal";
  return `<form id="${r.id ? "editReportForm" : "reportForm"}"><div class="form-grid">${field("日期 *", "date", r.date || state.date, "date", "required")}${ab ? field("車號", "car_no", r.car_no || "", "text", 'maxlength="30"') : ""}${field(ab ? "客戶名稱 *" : "客戶名稱＋車號 *", "store", r.store || "", "text", 'required list="customerNames" maxlength="200"')}${ab ? area("狀況說明 * · 格式：日期 品項 數量 原因", "reason", r.reason || "", 'required maxlength="4000"') + select("處理方式", "exchange_type", ["退貨", "換貨", "反應", "補貨"], r.exchange_type || "退貨") + select("異常類別", "category", categories, r.category || categories[0]) + field("責任歸屬 · 司機填寫", "responsibility", r.responsibility || "", "text", 'maxlength="150"') + area("補充說明 · 司機填寫", "note", r.note || "", 'maxlength="2000"') : area("交接事項 *", "content", r.content || "", 'required maxlength="4000"')}</div><datalist id="customerNames">${customers()
    .map((c) => `<option value="${e(c.name)}">${e(c.code)}</option>`)
    .join("")}${store
    .list("aliases")
    .map(
      (a) =>
        `<option value="${e(a.alias_name)}">${e(a.customer_code)}</option>`,
    )
    .join(
      "",
    )}</datalist><div class="form-actions">${r.id ? '<button class="btn" type="button" data-action="cancel-inline">取消</button>' : ""}<button class="btn primary" type="submit">${r.id ? "儲存變更" : "＋ 新增" + (ab ? "異常紀錄" : "交接事項")}</button></div></form>`;
}
function reportsPage() {
  const rows = reportRows();
  return (
    heading(
      "異常與交接",
      "讓每一件異常都有回應，每一項交接都有著落。",
      dateInput(),
    ) +
    `<div class="toolbar"><div class="segments"><button data-report="abnormal" class="${state.report === "abnormal" ? "active" : ""}">異常紀錄</button><button data-report="handover" class="${state.report === "handover" ? "active" : ""}">交接事項</button></div><div class="actions"><button class="btn small" data-action="print-report">▤ 列印 Excel</button><button class="btn small green" data-action="export-report">↓ 匯出 Excel</button><button class="btn small danger" data-action="clear-reports">刪除當日全部</button></div></div><div class="report-layout"><section class="panel"><h2>${state.report === "abnormal" ? "新增異常紀錄" : "新增交接事項"}</h2>${reportForm(state.addReportDraft)}</section><section class="panel"><div class="section-title"><h2>${state.report === "abnormal" ? "異常事件" : "交接事項"}<span>目前共 ${rows.length} 筆</span></h2><span class="subtle">${state.date}</span></div>${rows.length ? `<div class="table-wrap"><table><thead><tr>${(state.report === "abnormal" ? ["日期", "車號", "店家", "狀況說明", "處理方式", "異常類別", "責任歸屬", "補充說明"] : ["日期", "客戶名稱＋車號", "事項"]).map((h) => `<th>${h}</th>`).join("")}<th>操作</th></tr></thead><tbody>${rows.map((r) => `<tr>${(state.report === "abnormal" ? [r.date, r.car_no, r.store, r.reason, r.exchange_type, r.category, r.responsibility, r.note] : [r.date, r.store, r.content]).map((v, i) => `<td class="${i > 1 ? "wrap" : ""}">${state.report === "abnormal" && i === 4 ? `<span class="badge ${{ 退貨: "red", 換貨: "orange", 反應: "blue", 補貨: "green" }[v]}">${e(v)}</span>` : e(v)}</td>`).join("")}<td><button class="text-link" data-edit-report="${r.id}" aria-label="編輯紀錄">✎</button><button class="text-link" data-delete-report="${r.id}" aria-label="刪除紀錄">×</button></td></tr>${state.editReport?.id === r.id ? `<tr class="inline-edit-row"><td colspan="${state.report === "abnormal" ? 9 : 4}">${r.revision !== state.editReport.revision ? '<div class="inline-conflict">資料已在別處更新，目前草稿已保留；請取消後重新開啟取得最新版本。</div>' : ""}<div style="white-space:normal;padding:10px">${reportForm({ ...r, ...state.editReport.draft })}</div></td></tr>` : ""}`).join("")}</tbody></table></div><div class="pagination"><button class="btn small" data-action="report-prev" ${state.reportPages.length <= 1 ? "disabled" : ""}>上一頁</button><span>第 ${state.reportPages.length} 頁 · 每頁 50 筆</span><button class="btn small" data-action="report-next" ${rows.length < 50 ? "disabled" : ""}>下一頁</button></div>` : empty("目前沒有紀錄", "從左側新增今天的異常或交接事項。")}</section></div>`
  );
}
function customerPage() {
  const cs = customers().filter((c) =>
    [c.name, c.code, c.car_no, c.group].join(" ").includes(state.search),
  );
  return (
    heading(
      "客戶與車輛",
      "三套系統，共用一份清楚可靠的客戶資料。",
      `<button class="btn" data-action="import-customers">↑ 匯入客戶</button><button class="btn" data-action="vehicle">＋ 新增車輛</button><button class="btn primary" data-action="add-customer">＋ 新增客戶</button>`,
    ) +
    `<section class="panel"><div class="toolbar"><h2 style="font-size:16px">客戶主檔 <span class="badge">${cs.length} 位</span></h2><label class="search">⌕ <input id="search" value="${e(state.search)}" placeholder="搜尋名稱、代號、車號" aria-label="搜尋客戶主檔"></label></div>${cs.length ? `<div class="table-wrap"><table><thead><tr>${["客戶代號", "客戶名稱", "系列", "配送車號", "固定叫貨", "備註", "操作"].map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${cs.map((c) => `<tr><td>${e(c.code)}</td><td><strong>${e(c.name)}</strong></td><td>${e(c.group || "未分類")}</td><td><span class="badge">${e(c.car_no || "未配車")}</span></td><td>${c.fixed ? "✓" : "—"}</td><td class="wrap">${e(c.notes)}</td><td><button class="text-link" data-customer="${e(c.code)}">編輯</button><button class="text-link" data-aliases="${e(c.code)}">別名</button></td></tr>`).join("")}</tbody></table></div>` : empty("還沒有客戶資料", "可以手動新增，或從 Excel 匯入客戶代號與名稱。")}</section><section class="panel" style="margin-top:24px"><div class="section-title"><h2>車輛主檔</h2><span class="subtle">以客戶編輯中的配送車號關聯</span></div><div class="filter-row">${
      store
        .list("vehicles")
        .map(
          (v) =>
            `<span class="badge blue">${e(v.car_no)} · ${e(v.notes || "配送車輛")}</span>`,
        )
        .join("") || '<span class="subtle">尚未新增車輛。</span>'
    }</div></section>`
  );
}
function quotesPage() {
  const cs = customers().filter((c) => profile(c).mode === state.quoteMode);
  const filtered = cs
    .filter(quoteMatch)
    .filter(
      (c) =>
        state.stage === "all" ||
        (state.stage === "lookup"
          ? (store.cloud ? (store.mappingCounts?.[c.code] ?? -1) : store.list("mappings", (m) => m.customer_code === c.code).length) === 0
          : stage(c) === state.stage),
    );
  const selected = customers().filter((c) => state.selected.has(c.code));
  const detail = customers().find((c) => c.code === state.quoteCustomer);
  return (
    heading(
      "報價單管理",
      "把不同格式的報價，整理成一致、準確的每一期。",
      `<button class="btn" data-action="batch-quotes">↑ 批次匯入報價</button><button class="btn" data-action="master">▧ 品項主檔</button><button class="btn primary" data-action="add-customer">＋ 新增客戶</button>`,
    ) +
    `<div class="toolbar"><div class="segments">${["有貨號", "無貨號"].map((m) => `<button data-quote-mode="${m}" class="${state.quoteMode === m ? "active" : ""}">${m}客戶</button>`).join("")}</div><button class="text-link" data-action="reset-exports">重置本期匯出狀態</button></div><div class="stage-grid">${[
      ["setup", "① 待設定匯出格式", "先設定客戶欄位範本"],
      ["upload", "② 待上傳報價單", "上傳並儲存本期品項"],
      ["ready", "③ 可批次匯出", "勾選後，一次完成匯出"],
    ]
      .map(
        ([s, t, d]) =>
          `<button class="stage ${state.stage === s ? "active" : ""}" data-stage="${s}"><small>${t}</small><strong>${cs.filter((c) => stage(c) === s).length}</strong><span>${d}</span></button>`,
      )
      .join(
        "",
      )}</div>${state.quoteMode === "無貨號" ? `<button class="chip ${state.stage === "lookup" ? "active" : ""}" data-stage="lookup" style="margin-bottom:20px">待設定料號對照表</button>` : ""}<div class="quote-layout"><section class="panel"><div class="toolbar"><div class="actions"><button class="chip ${state.stage === "all" ? "active" : ""}" data-stage="all">全部客戶</button><span class="subtle">${filtered.length} 位</span><select id="quoteCycle" aria-label="報價週期篩選"><option value="all">全部週期</option>${[7, 10, 15, 30].map((n) => `<option value="${n}" ${state.quoteCycle === String(n) ? "selected" : ""}>${n} 天</option>`).join("")}</select>${
      state.quoteMode === "無貨號"
        ? `<select id="quoteUnit" aria-label="報價單位篩選">${[
            ["all", "全部單位"],
            ["kg", "kg"],
            ["台斤", "台斤"],
            ["unset", "未設定"],
          ]
            .map(
              ([v, l]) =>
                `<option value="${v}" ${state.quoteUnit === v ? "selected" : ""}>${l}</option>`,
            )
            .join("")}</select>`
        : ""
    }</div><label class="search">⌕ <input id="search" value="${e(state.search)}" placeholder="搜尋客戶名稱、代號" aria-label="搜尋報價客戶"></label></div>${
      filtered.length
        ? `<div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="selectAllQuotes" aria-label="勾選所有可匯出客戶" ${filtered.filter((c) => stage(c) === "ready").length && filtered.filter((c) => stage(c) === "ready").every((c) => state.selected.has(c.code)) ? "checked" : ""}></th><th>客戶</th><th>週期／到期日</th><th>狀態</th><th>下一步</th></tr></thead><tbody>${filtered
            .map((c) => {
              const p = profile(c),
                s = stage(c);
              return `<tr><td><input type="checkbox" data-quote-select="${e(c.code)}" aria-label="選取 ${e(c.name)}" ${s !== "ready" ? "disabled" : ""} ${state.selected.has(c.code) ? "checked" : ""}></td><td><button class="text-link" data-quote-detail="${e(c.code)}"><strong>${e(c.name)}</strong></button><br><span class="subtle">${e(c.code)}${p.unit ? " · " + e(p.unit) : ""}${p.item_count ? " · " + p.item_count + " 項" : ""}</span></td><td>${p.cycle} 天<br><span class="subtle">${due(c) || "尚未匯出"}</span></td><td><span class="badge ${s === "ready" ? "green" : s === "upload" ? "blue" : "orange"}">${p.exported ? "已匯出" : s === "ready" ? "可匯出" : s === "upload" ? "待上傳" : "待設定"}</span></td><td><button class="btn small" data-wizard="${e(c.code)}">${s === "setup" ? "設定格式" : "上傳報價"} ↗</button></td></tr>`;
            })
            .join("")}</tbody></table></div>`
        : empty(
            "還沒有" + state.quoteMode + "客戶",
            "在客戶的報價設定中，可切換有貨號／無貨號模式。",
          )
    }</section><aside class="right-rail">${detail ? quoteDetail(detail) : `<section class="panel"><div class="rail-heading">▧ 客戶報價設定</div><p class="subtle">點擊客戶名稱查看詳情、設定報價週期與單位，或管理料號對照表。</p></section>`}<section class="panel tray"><h2>本期匯出清單 <span class="badge">${selected.length}</span></h2>${selected.map((c) => `<div class="tray-row"><span>${e(c.name)}</span><span>${profile(c).item_count} 項 <button class="text-link" data-remove-tray="${e(c.code)}">×</button></span></div>`).join("") || '<p class="subtle">勾選左側客戶，建立本期匯出清單。</p>'}<div class="tray-row"><strong>合計品項</strong><strong>${selected.reduce((s, c) => s + Number(profile(c).item_count || 0), 0)}</strong></div><button class="btn green" data-action="export-quotes" ${!selected.length ? "disabled" : ""}>↓ 匯出 Excel</button><div class="actions" style="margin-top:12px"><button class="btn small" data-action="batch-edit-customers" ${!selected.length ? "disabled" : ""}>批次修改</button><button class="btn small danger" data-action="batch-delete-customers" ${!selected.length ? "disabled" : ""}>批次停用</button></div><div class="rail-footer"><button class="text-link" data-action="clear-tray">清空清單</button></div><p class="subtle">Excel 在本機產生，不上傳原始檔。取消存檔不會標示已匯出。</p></section></aside></div>`
  );
}
function quoteDetail(c) {
  const p = profile(c);
  return `<section class="panel"><div class="section-title"><h2>${e(c.name)}</h2><button class="text-link" data-profile="${e(c.code)}">編輯</button></div><p class="subtle">${p.mode} · ${p.cycle} 天週期 · ${p.unit || "單位未設定"}</p><div class="tray-row"><span>最後匯出</span><span>${dateShort(p.last_export_time)}</span></div><div class="tray-row"><span>已儲存品項</span><span>${p.item_count || 0}</span></div><div class="actions" style="margin-top:15px"><button class="btn small" data-records="${e(c.code)}">查看紀錄</button><button class="btn small danger" data-action="clear-quote-records">清除紀錄</button>${p.mode === "無貨號" ? `<button class="btn small" data-mappings="${e(c.code)}">料號對照</button>` : ""}</div><p class="subtle" style="margin-top:15px">檔案位置備忘：${e(p.file_location || "尚未設定")}</p></section>`;
}
function settingsPage() {
  const c = readConfig();
  return (
    heading("系統設定", "同一個工作空間，連接每一位夥伴。") +
    `<div class="settings-grid"><section class="panel"><h2>Supabase 共用連線</h2><p>三套系統共用一個專案。請先依 README 部署 SQL 與成員權限，再儲存連線並登入。此設定僅儲存在目前瀏覽器。</p><div class="form-note ${store.cloud ? "" : "warning"}">${store.cloud ? "已登入雲端；資料依成員權限存取。" : "目前使用本機模式。資料不會傳送到 Supabase，也不代表多裝置同步。"}</div><form id="configForm">${field("專案基本網址", "url", c.url || "", "url", 'required placeholder="https://your-project.supabase.co"')}${field("Anon / Publishable key", "key", c.key || "", "password", 'required autocomplete="off"')}<p class="subtle">僅接受公開金鑰；不接受 service_role 或 secret key。</p><button class="btn primary" type="submit">儲存連線設定</button></form><div style="border-top:1px solid var(--line);margin-top:25px;padding-top:22px"><h2>成員登入</h2>${store.cloud ? `<p>已登入 · 角色：${e(store.role)}</p><button class="btn" data-action="logout">登出</button>` : `<form id="loginForm">${field("電子郵件", "email", "", "email", 'required autocomplete="username"')}${field("密碼", "password", "", "password", 'required autocomplete="current-password"')}<button class="btn primary" type="submit">登入工作空間</button></form>`}</div></section><aside class="right-rail"><section class="panel"><h2>資料與備份</h2><p>本機資料只屬於此瀏覽器。正式切換雲端前，請下載備份並依遷移文件核對。</p><div class="actions"><button class="btn" data-action="backup">↓ 備份本機 JSON</button><button class="btn" data-action="restore">↑ 還原本機備份</button></div><button class="text-link" data-action="demo" style="margin-top:20px">載入示範資料（僅空白本機）</button></section><section class="panel"><h2>傳輸量觀測</h2><p>目前頁面 RPC 回應計量，未包含 TLS、WebSocket 心跳與 Auth；正式用量以 Supabase Usage 為準。</p><div class="tray-row"><span>API 回應</span><strong>${(store.metrics.apiBytes / 1000).toFixed(1)} KB</strong></div><div class="tray-row"><span>API 請求</span><strong>${store.metrics.requests}</strong></div><div class="tray-row"><span>增量通知</span><strong>${store.metrics.events}</strong></div><p class="subtle" style="margin-top:15px">規劃目標 3 GB／月 · 4 GB 警戒<br>尚未進行真實帳戶流量驗收。</p></section></aside></div>`
  );
}
function historyPage() {
  const rows = (
    state.historyRows ||
    store.list(
      "orders",
      (r) =>
        r.date <= state.date &&
        r.date >=
          new Date(
            new Date(state.date + "T00:00:00Z").getTime() - 29 * 86400000,
          )
            .toISOString()
            .slice(0, 10),
    )
  )
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 50);
  const ds = [...new Set(rows.map((r) => r.date))].sort().slice(-7);
  return (
    heading(
      "歷史紀錄",
      "回顧作業進度，留下每一天用心服務的軌跡。",
      dateInput() +
        `<button class="btn" data-action="order-export">↓ 匯出紀錄</button>`,
    ) +
    `<section class="panel"><div class="section-title"><h2>每日叫貨趨勢</h2><button class="text-link" data-action="manual-trend">手動趨勢資料</button><span class="subtle">目前載入紀錄 · 非全量統計</span></div>${
      ds.length
        ? `<div class="chart-bars">${ds
            .map((d) => {
              const n = rows.filter(
                (r) => r.date === d && r.status === "ordered",
              ).length;
              return `<div class="chart-bar" style="height:${Math.max(5, (n / Math.max(1, customers().length)) * 100)}%" title="${d} · ${n} 位已叫貨"><small>${d.slice(5)} · ${n}</small></div>`;
            })
            .join("")}</div>`
        : ""
    }<div class="section-title" style="margin-top:45px"><h2>作業紀錄</h2><span class="subtle">預設近 30 天，每頁最多 50 筆</span></div>${rows.length ? rows.map((o) => `<div class="history-row"><span class="avatar">${o.status === "ordered" ? "✓" : "◷"}</span><div><strong>${e(customers().find((c) => c.code === o.customer_code)?.name || o.customer_code)}</strong><small>${o.date} · ${time(o.at)} · ${o.status === "ordered" ? "已叫貨" : o.status === "off" ? "不叫貨" : "待叫貨"}</small></div><span class="badge" style="margin-left:auto;align-self:center">版本 ${o.revision}</span></div>`).join("") : empty("尚無歷史紀錄", "每日的叫貨操作會保留在對應的日期。")}<div class="pagination">${store.cloud ? `<button class="btn small" data-action="history-prev" ${state.historyPages.length <= 1 ? "disabled" : ""}>上一頁</button><button class="btn small" data-action="history-next" ${rows.length < 50 ? "disabled" : ""}>下一頁</button>` : "<span>本機紀錄最多顯示最近 50 筆，可匯出全部備份。</span>"}</div></section>`
  );
}
function render() {
  const focus = document.activeElement,
    selection = focus?.selectionStart,
    focusId = focus?.id;
  $("#breadcrumb").textContent = labels[state.page];
  document.title = `${labels[state.page]}｜忠欣蔬果`;
  $("nav")
    .querySelectorAll("a")
    .forEach((a) =>
      a.classList.toggle("active", a.dataset.page === state.page),
    );
  main.innerHTML = {
    orders: orderPage,
    reports: reportsPage,
    customers: customerPage,
    quotes: quotesPage,
    history: historyPage,
    settings: settingsPage,
  }[state.page]();
  $("#connection").classList.toggle("cloud", store.cloud);
  $("#connection").innerHTML = `<i></i>${e(store.status)}`;
  $("#navPending").textContent = customers().filter(
    (c) => status(c) === "pending",
  ).length;
  $("#footerStatus").textContent = store.cloud
    ? "共用雲端 · " + store.status
    : "本機儲存 · 不會寫入既有雲端資料";
  $("#userName").textContent = store.cloud ? "內部成員" : "本機工作空間";
  $("#userRole").textContent = store.cloud ? store.role : "資料保存在此瀏覽器";
  if (focusId === "search" && $("#search")) {
    $("#search").focus();
    $("#search").setSelectionRange(selection, selection);
  }
}
store.addEventListener("change", () => {
  if (modalRecord?.id && $("#modal").open) {
    const r = store.get(modalRecord.kind, modalRecord.id);
    if (
      r &&
      r.revision !== modalRecord.revision &&
      !$("#modalBody .inline-conflict")
    )
      $("#modalBody").insertAdjacentHTML(
        "afterbegin",
        '<div class="inline-conflict" role="alert">資料已變更。保留目前草稿，儲存時會檢查版本；請關閉後重新開啟以取得最新資料。</div>',
      );
  }
  if (!renderQueued) {
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      const form = document.activeElement?.closest("form");
      if (form && ["reportForm", "editReportForm"].includes(form.id)) {
        const values = Object.fromEntries(new FormData(form));
        render();
        for (const [k, v] of Object.entries(values)) {
          const f = document.getElementById(form.id)?.elements[k];
          if (f) f.value = v;
        }
      } else render();
    });
  }
});
function reportRows() {
  return store
    .list(state.report, (r) => r.date === state.date)
    .filter((r) => !state.reportBefore || r.id < state.reportBefore)
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 50);
}
async function loadPage() {
  if (store.cloud && state.page === "quotes")
    store.mappingCounts = await store.rpc("lookup_counts");
  store.activeDay = state.date;
  if (!store.cloud) return;
  for (const kind of [
    "customers",
    "profiles",
    "vehicles",
    "notices",
    "groups",
    "manual",
  ])
    if (!store.loaded.has(kind)) await store.loadAllSmall(kind);
  if (state.page === "orders")
    await store.load("orders", { day: state.date, limit: 500 });
  if (state.page === "reports" && !store.loaded.has("aliases"))
    await store.loadAllSmall("aliases");
  if (state.page === "reports" && !store.loaded.has("assignments"))
    await store.loadAllSmall("assignments");
  if (state.page === "reports")
    await store.load(state.report, {
      day: state.date,
      before: state.reportBefore,
      limit: 50,
    });
  if (state.page === "history") {
    const rs = await store.rpc("history", {
      p_date: state.date,
      p_before: state.historyBefore,
    });
    state.historyRows = rs.map((r) => ({
      ...r.data,
      id: r.id,
      revision: r.revision,
    }));
    render();
  }
}
async function route() {
  state.page = labels[location.hash.slice(1)]
    ? location.hash.slice(1)
    : "orders";
  state.search = "";
  state.filter = "all";
  render();
  await safe(loadPage);
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", () => store.pause());
main.addEventListener("input", (ev) => {
  if (ev.target.closest("#reportForm"))
    state.addReportDraft = Object.fromEntries(
      new FormData(ev.target.closest("form")),
    );
  if (state.editReport && ev.target.closest(".inline-edit-row"))
    state.editReport.draft = {
      ...state.editReport.draft,
      ...Object.fromEntries(new FormData(ev.target.closest("form"))),
    };
  if (ev.target.id === "search") {
    state.search = ev.target.value;
    render();
  }
  if (ev.target.name === "store" && state.page === "reports") {
    const aliasCodes = store
      .list("aliases", (a) => a.alias_name === ev.target.value)
      .map((a) => a.customer_code);
    const cs = customers().filter(
      (c) => c.name === ev.target.value || aliasCodes.includes(c.code),
    );
    if (cs.length === 1) {
      const form = ev.target.closest("form");
      if (form.elements.car_no) {
        const a = store.list(
          "assignments",
          (a) =>
            a.customer_code === cs[0].code &&
            a.is_primary &&
            (!a.effective_from || a.effective_from <= state.date) &&
            (!a.effective_to || a.effective_to >= state.date),
        )[0];
        const car =
          store.get("vehicles", a?.vehicle_id)?.car_no || cs[0].car_no || "";
        form.elements.car_no.value = car;
        let hint = form.elements.car_no.closest("label").querySelector("small");
        if (!hint) {
          hint = document.createElement("small");
          form.elements.car_no.closest("label").append(hint);
        }
        hint.textContent = a
          ? "已依有效配送關聯帶入，請確認車號。"
          : "依客戶主檔帶入，請確認車號。";
      }
      const draft = Object.fromEntries(new FormData(form));
      if (form.id === "editReportForm")
        state.editReport.draft = { ...state.editReport.draft, ...draft };
      else state.addReportDraft = draft;
    }
  }
});
main.addEventListener("change", (ev) =>
  safe(async () => {
    const t = ev.target;
    if (t.id === "quoteCycle") {
      state.quoteCycle = t.value;
      render();
    }
    if (t.id === "quoteUnit") {
      state.quoteUnit = t.value;
      render();
    }
    if (t.id === "workDate") {
      if (!t.value) return;
      state.date = t.value;
      state.addReportDraft = {};
      state.editReport = null;
      state.historyBefore = null;
      state.historyPages = [null];
      state.historyRows = null;
      state.reportBefore = null;
      state.reportPages = [null];
      render();
      await loadPage();
    }
    if (t.dataset.quoteSelect) {
      t.checked
        ? state.selected.add(t.dataset.quoteSelect)
        : state.selected.delete(t.dataset.quoteSelect);
      render();
    }
    if (t.id === "selectAllQuotes") {
      customers()
        .filter(
          (c) =>
            profile(c).mode === state.quoteMode &&
            stage(c) === "ready" &&
            (state.stage === "all" || stage(c) === state.stage) &&
            quoteMatch(c),
        )
        .forEach((c) =>
          t.checked
            ? state.selected.add(c.code)
            : state.selected.delete(c.code),
        );
      render();
    }
  }),
);
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button,a");
  if (!t) return;
  safe(async () => {
    if (t.dataset.filter) {
      state.filter = t.dataset.filter;
      render();
    }
    if (t.dataset.group) {
      state.group = t.dataset.group;
      render();
    }
    if (t.dataset.view) {
      state.view = t.dataset.view;
      render();
    }
    if (t.dataset.check) await changeOrder(t.dataset.check);
    if (t.dataset.editOrder) editOrder(t.dataset.editOrder);
    if (t.dataset.customer) editCustomer(t.dataset.customer);
    if (t.dataset.aliases) await aliasesModal(t.dataset.aliases);
    if (t.dataset.report) {
      state.report = t.dataset.report;
      state.addReportDraft = {};
      state.editReport = null;
      state.reportBefore = null;
      state.reportPages = [null];
      render();
      await loadPage();
    }
    if (t.dataset.editReport) {
      const r = store.get(state.report, t.dataset.editReport);
      state.editReport = { id: r.id, revision: r.revision, draft: { ...r } };
      render();
      main.querySelector(".inline-edit-row input")?.focus();
    }
    if (t.dataset.deleteReport) {
      const r = store.get(state.report, t.dataset.deleteReport);
      if (confirm("確定刪除此筆紀錄？"))
        await store.mutate(state.report, r.id, r, {
          revision: r.revision,
          remove: true,
        });
    }
    if (t.dataset.deleteNotice) {
      const r = store.get("notices", t.dataset.deleteNotice);
      if (confirm("確定刪除此公告？"))
        await store.mutate("notices", r.id, r, {
          revision: r.revision,
          remove: true,
        });
    }
    if (t.dataset.quoteMode) {
      state.quoteMode = t.dataset.quoteMode;
      state.stage = "all";
      state.quoteCycle = "all";
      state.quoteUnit = "all";
      state.selected.clear();
      state.quoteCustomer = null;
      render();
    }
    if (t.dataset.stage) {
      state.stage = t.dataset.stage;
      render();
    }
    if (t.dataset.quoteDetail) {
      state.quoteCustomer = t.dataset.quoteDetail;
      render();
    }
    if (t.dataset.profile) editProfile(t.dataset.profile);
    if (t.dataset.wizard) await openWizard(t.dataset.wizard);
    if (t.dataset.records) await viewRecords(t.dataset.records);
    if (t.dataset.mappings) await mappingsModal(t.dataset.mappings);
    if (t.dataset.removeTray) {
      state.selected.delete(t.dataset.removeTray);
      render();
    }
    if (t.dataset.action) await action(t.dataset.action);
  });
});
async function action(a) {
  if (a === "cancel-inline") {
    state.editReport = null;
    return render();
  }
  if (a === "batch-edit-customers") return batchEditModal();
  if (a === "batch-delete-customers") {
    if (store.cloud && store.role !== "admin")
      throw Error("僅管理員可批次停用客戶");
    if (!confirm("將停用勾選客戶，歷史資料仍完整保留。是否繼續？")) return;
    const cs = customers().filter((c) => state.selected.has(c.code));
    await store.batch(
      cs.map((c) => ({
        kind: "customers",
        id: c.id,
        data: { ...c, active: false },
        revision: c.revision,
      })),
    );
    state.selected.clear();
    return render();
  }
  if (a === "clear-quote-records") {
    const c = customers().find((c) => c.code === state.quoteCustomer);
    if (!c) return;
    if (!confirm("將清除此客戶暫存報價，保留匯出歷史摘要。確定繼續？")) return;
    const rows = await fetchDetail("quote_items", c.code),
      p = profile(c);
    await store.batch([
      ...rows.map((r) => ({
        kind: "quote_items",
        id: r.id,
        data: r,
        revision: r.revision,
        remove: true,
      })),
      {
        kind: "profiles",
        id: p.id,
        data: { ...p, item_count: 0, exported: false },
        revision: p.revision,
      },
    ]);
    return render();
  }
  if (a === "fixed-filter") {
    state.fixedOnly = !state.fixedOnly;
    return render();
  }
  if (a === "warn-filter") {
    if (!state.warnOnly) {
      if (store.cloud)
        state.warnCodes = await store.rpc("warn3", { p_date: state.date });
      else {
        const start = new Date(
          new Date(state.date + "T00:00:00Z").getTime() - 2 * 86400000,
        )
          .toISOString()
          .slice(0, 10);
        state.warnCodes = customers()
          .filter(
            (c) =>
              !store.list(
                "orders",
                (o) =>
                  o.customer_code === c.code &&
                  o.date >= start &&
                  o.date <= state.date &&
                  o.status === "ordered",
              ).length,
          )
          .map((c) => c.code);
      }
    }
    state.warnOnly = !state.warnOnly;
    return render();
  }
  if (a === "manual-trend") return manualTrend();
  if (a === "batch-quotes") return batchQuoteModal();
  if (a === "report-next") {
    state.reportBefore = reportRows().at(-1)?.id;
    state.reportPages.push(state.reportBefore);
    await loadPage();
    return render();
  }
  if (a === "report-prev") {
    state.reportPages.pop();
    state.reportBefore = state.reportPages.at(-1);
    await loadPage();
    return render();
  }
  if (["settings", "history"].includes(a)) {
    location.hash = a;
    return;
  }
  if (a === "close-modal") return closeModal();
  if (a === "add-customer") return editCustomer();
  if (a === "demo") {
    store.demo();
    toast("示範資料已載入，所有名稱與紀錄僅供操作體驗。");
    return;
  }
  if (a === "help")
    return openModal(
      "開始使用忠欣工作台",
      `<div class="form-note">① 新增或匯入客戶 → ② 在每日打勾單確認叫貨 → ③ 記錄異常與交接 → ④ 匯入與匯出客戶報價。</div><p>目前${store.cloud ? "已連接共用雲端" : "為本機模式，資料儲存在此瀏覽器"}。正式使用前，請在系統設定完成 Supabase 與成員登入。</p><p style="margin-top:15px">晴天娃娃 LOGO、指定 PNG 圖示及 Excel 範本尚未提供；目前使用文字與通用符號。</p>`,
    );
  if (a === "notice")
    return openModal(
      "新增工作公告",
      `<form id="noticeForm">${field("標題 *", "title", "", "text", 'required maxlength="100"')}${area("內容 *", "text", "", 'required maxlength="2000"')}${formButtons("發布公告")}</form>`,
    );
  if (a === "vehicle")
    return openModal(
      "新增配送車輛",
      `<form id="vehicleForm">${field("車號 *", "car_no", "", "text", 'required maxlength="30"')}${field("備註", "notes", "", "text", 'maxlength="500"')}${formButtons()}</form>`,
    );
  if (a === "clear-tray") {
    state.selected.clear();
    return render();
  }
  if (a === "export-quotes") return exportQuotes();
  if (a === "print-report") {
    await allReportRows();
    return printPreview();
  }
  if (a === "export-report") {
    const rows = await allReportRows();
    if (!rows.length) throw Error("目前沒有可匯出的紀錄。");
    const ok = await saveWorkbook(
      await reportWorkbook(state.report, rows, state.date),
      `${state.date}-${state.report === "abnormal" ? "異常表" : "交接表"}.xlsx`,
    );
    if (ok) toast("Excel 已產生");
    return;
  }
  if (a === "clear-reports") {
    if (store.cloud && store.role !== "admin")
      throw Error("僅管理員可刪除全部。");
    if (!confirm("刪除所選日期的全部紀錄？")) return;
    if (!confirm("此操作無法復原。再次確認刪除？")) return;
    await store.batch(
      (await allReportRows()).map((r) => ({
        kind: state.report,
        id: r.id,
        data: r,
        revision: r.revision,
        remove: true,
      })),
    );
    return;
  }
  if (a === "backup") {
    if (store.cloud)
      throw Error("此按鈕只備份本機工作空間；雲端請用資料庫備份流程。");
    download(
      JSON.stringify({ version: 1, rows: store.rows }, null, 2),
      "忠欣本機備份.json",
      "application/json",
    );
    return;
  }
  if (a === "restore") return restore();
  if (a === "logout") {
    await store.sb.auth.signOut();
    return render();
  }
  if (a === "order-export") return exportOrders();
  if (a === "import-customers") return importCustomers();
  if (a === "master") return masterModal();
  if (a === "reset-exports") {
    if (!confirm("重置目前頁籤所有客戶的本期匯出標記？")) return;
    for (const p of profiles().filter((p) => p.mode === state.quoteMode))
      await store.mutate(
        "profiles",
        p.id,
        { ...p, exported: false },
        { revision: p.revision },
      );
    toast("本期匯出狀態已重置");
    return;
  }
  if (a === "wizard-next") return wizardNext();
  if (a === "wizard-back") {
    wizard.step--;
    wizardRender();
    return;
  }
  if (a === "wizard-save") return saveWizard();
  if (a === "do-print") {
    $("#modal").classList.add("printing");
    window.print();
    return;
  }
  if (a === "history-next") {
    state.historyBefore = (state.historyRows || []).at(-1)?.id;
    state.historyPages.push(state.historyBefore);
    await loadPage();
    return;
  }
  if (a === "history-prev") {
    state.historyPages.pop();
    state.historyBefore = state.historyPages.at(-1);
    await loadPage();
    return;
  }
}
document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (!(f instanceof HTMLFormElement)) return;
  const data = Object.fromEntries(new FormData(f)),
    submit = f.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  safe(async () => {
    if (f.id === "customerForm") {
      if (!modalRecord.id && store.get("customers", data.code))
        throw Error("此客戶代號已存在。");
      const ops = [
        {
          kind: "customers",
          id: data.code,
          data: {
            ...data,
            fixed: data.fixed === "yes",
            active: data.active === "yes",
          },
          revision: modalRecord.revision,
        },
      ];
      if (data.car_no) {
        let v = store.list("vehicles").find((v) => v.car_no === data.car_no);
        if (!v) {
          v = { id: uid(), car_no: data.car_no };
          ops.push({
            kind: "vehicles",
            id: v.id,
            data: { car_no: v.car_no, active: true },
          });
        }
        const assignments = await fetchDetail("assignments", data.code);
        const assignment = assignments.find(
          (a) => a.is_primary && (!a.effective_to || a.effective_to >= today()),
        );
        if (assignment && assignment.vehicle_id !== v.id)
          ops.push({
            kind: "assignments",
            id: assignment.id,
            data: { ...assignment, effective_to: today(), is_primary: false },
            revision: assignment.revision,
          });
        if (!assignment || assignment.vehicle_id !== v.id)
          ops.push({
            kind: "assignments",
            id: uid(),
            data: {
              customer_code: data.code,
              vehicle_id: v.id,
              is_primary: true,
              effective_from: today(),
              effective_to: null,
            },
          });
      }
      await store.batch(ops);
      closeModal();
      toast("客戶資料已儲存");
    }
    if (f.id === "orderForm")
      await changeOrder(f.dataset.code, data.status, modalRecord.revision);
    if (["reportForm", "editReportForm"].includes(f.id)) {
      const editing = f.id === "editReportForm";
      const reportEdit = state.editReport;
      const aliasCodes = store
        .list("aliases", (a) => a.alias_name === data.store)
        .map((a) => a.customer_code);
      const match = customers().filter(
        (c) => c.name === data.store || aliasCodes.includes(c.code),
      );
      await store.mutate(
        state.report,
        editing ? reportEdit.id : uid(),
        {
          ...data,
          customer_code: match.length === 1 ? match[0].code : null,
          at: new Date().toISOString(),
        },
        { revision: editing ? reportEdit.revision : 0 },
      );
      state.editReport = null;
      state.addReportDraft = {};
      render();
      toast("紀錄已儲存");
    }
    if (f.id === "noticeForm") {
      await store.mutate("notices", uid(), {
        ...data,
        at: new Date().toISOString(),
      });
      closeModal();
      toast("公告已發布");
    }
    if (f.id === "vehicleForm") {
      if (store.list("vehicles").some((v) => v.car_no === data.car_no))
        throw Error("車號已存在。");
      await store.mutate("vehicles", uid(), { ...data, active: true });
      closeModal();
    }
    if (f.id === "configForm") {
      saveConfig(data.url, data.key);
      await store.initCloud();
      toast("連線設定已儲存，請登入內部成員帳號。");
      render();
    }
    if (f.id === "loginForm") {
      await store.login(data.email, data.password);
      await loadPage();
      toast("已登入共用工作空間");
      render();
    }
    if (f.id === "aliasForm") {
      const id = uid();
      await store.mutate("aliases", id, {
        customer_code: f.dataset.code,
        alias_name: data.alias_name,
        created_at: new Date().toISOString(),
      });
      await aliasesModal(f.dataset.code);
    }
    if (f.id === "batchProfileForm") {
      const ops = customers()
        .filter((c) => state.selected.has(c.code))
        .map((c) => {
          const p = profile(c);
          return {
            kind: "profiles",
            id: p.id,
            data: {
              ...p,
              ...(data.cycle ? { cycle: Number(data.cycle) } : {}),
              ...(data.unit !== "keep" ? { unit: data.unit } : {}),
            },
            revision: p.revision,
          };
        });
      await store.batch(ops);
      closeModal();
      toast("批次報價設定已更新");
    }
    if (f.id === "manualForm") {
      const old = store.get("manual", data.date);
      await store.mutate(
        "manual",
        data.date,
        { date: data.date, count: Number(data.count), note: data.note },
        { revision: old?.revision || 0 },
      );
      closeModal();
      toast("手動趨勢資料已儲存");
    }
    if (f.id === "profileForm") {
      const p = profile(customers().find((c) => c.code === f.dataset.code));
      await store.mutate(
        "profiles",
        p.id,
        { ...p, ...data, cycle: Number(data.cycle) },
        { revision: modalRecord.revision },
      );
      closeModal();
    }
    if (f.id === "mappingForm") {
      const id = f.dataset.code + ":" + data.customer_name;
      const old = store.get("mappings", id);
      await store.mutate(
        "mappings",
        id,
        { ...data, customer_code: f.dataset.code },
        { revision: old?.revision || 0 },
      );
      await mappingsModal(f.dataset.code);
    }
  }).finally(() => {
    if (submit) submit.disabled = false;
  });
});
function editProfile(code) {
  const c = customers().find((c) => c.code === code),
    p = profile(c);
  modalRecord = { kind: "profiles", id: code, revision: p.revision };
  openModal(
    "客戶報價設定",
    `<form id="profileForm" data-code="${e(code)}"><div class="form-note">${e(c.name)} · ${e(code)}</div><div class="form-grid">${select("品項識別模式", "mode", ["有貨號", "無貨號"], p.mode)}${select(
      "報價週期",
      "cycle",
      [
        ["7", "7 天"],
        ["10", "10 天"],
        ["15", "15 天"],
        ["30", "30 天"],
      ],
      String(p.cycle),
    )}${select(
      "報價單位",
      "unit",
      [
        ["", "未設定"],
        ["kg", "kg"],
        ["台斤", "台斤"],
      ],
      p.unit || "",
    )}${field("檔案位置備忘", "file_location", p.file_location || "", "text", 'maxlength="500"')}${area("備註", "notes", p.notes || "")}</div>${formButtons()}</form>`,
  );
}
async function fetchDetail(kind, code) {
  if (store.cloud) {
    let before = null,
      rs;
    do {
      rs = await store.rpc("details", {
        p_kind: kind,
        p_customer: code,
        p_before: before,
      });
      for (const r of rs) store.merge(r);
      before = rs.at(-1)?.id;
    } while (rs.length === 50);
  }
  return store.list(kind, (r) => r.customer_code === code);
}
async function viewRecords(code) {
  const rows = await fetchDetail("quote_items", code);
  openModal(
    "已儲存報價紀錄",
    `<p class="subtle">${e(customers().find((c) => c.code === code)?.name)} · ${rows.length} 項</p><div class="table-wrap"><table><thead><tr><th>貨號</th><th>品名</th><th>單位</th><th>單價</th><th>不報價原因</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${e(r.item.貨號 || r.item.忠欣料號)}</td><td>${e(r.item.品名)}</td><td>${e(r.item.單位)}</td><td>${e(r.item.單價)}</td><td>${e(r.item.不報價原因)}</td></tr>`).join("")}</tbody></table></div>`,
    true,
  );
}
async function mappingsModal(code) {
  const rows = await fetchDetail("mappings", code);
  if (store.cloud) {
    store.mappingCounts = { ...store.mappingCounts, [code]: rows.length };
    render();
  }
  if (store.cloud && !store.loaded.has("master_items"))
    await store.loadAllSmall("master_items");
  openModal(
    "客戶料號對照表",
    `<div class="toolbar"><p class="subtle">${e(customers().find((c) => c.code === code)?.name)} · ${rows.length} 筆對照</p><button class="btn small" id="mappingImport">↑ Excel 整批取代</button></div><form id="mappingForm" data-code="${e(code)}"><div class="form-grid">${field("客戶品名 *", "customer_name", "", "text", "required")}${field("忠欣料號 *", "item_code", "", "text", 'required list="masterNames"')}</div><p id="mappingOfficialName" class="subtle" style="margin-top:8px">輸入料號後顯示主檔品名。</p><datalist id="masterNames">${store
      .list("master_items")
      .map(
        (m) => `<option value="${e(m.item_code)}">${e(m.item_name)}</option>`,
      )
      .join(
        "",
      )}</datalist><div class="form-actions"><button class="btn primary" type="submit">新增／更新對照</button></div></form><div class="table-wrap" style="margin-top:20px"><table><thead><tr><th>客戶品名</th><th>忠欣料號</th><th>品項名稱</th><th>操作</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${e(r.customer_name)}</td><td>${e(r.item_code)}</td><td>${e(store.list("master_items").find((m) => m.item_code === r.item_code)?.item_name || "主檔未找到")}</td><td><button type="button" class="text-link" data-map-edit="${e(r.id)}">編輯</button><button type="button" class="text-link" data-map-delete="${e(r.id)}">刪除</button></td></tr>`).join("")}</tbody></table></div>`,
  );
  const form = $("#mappingForm");
  form.elements.item_code.oninput = () =>
    ($("#mappingOfficialName").textContent =
      store
        .list("master_items")
        .find((m) => m.item_code === form.elements.item_code.value)
        ?.item_name || "主檔未找到此料號");
  $("#modalBody")
    .querySelectorAll("[data-map-edit]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          const r = store.get("mappings", b.dataset.mapEdit);
          form.elements.customer_name.value = r.customer_name;
          form.elements.item_code.value = r.item_code;
          form.elements.customer_name.readOnly = true;
          form.elements.item_code.focus();
        }),
    );
  $("#modalBody")
    .querySelectorAll("[data-map-delete]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          safe(async () => {
            const r = store.get("mappings", b.dataset.mapDelete);
            if (!confirm(`刪除「${r.customer_name}」對照？`)) return;
            await store.mutate("mappings", r.id, r, {
              revision: r.revision,
              remove: true,
            });
            await mappingsModal(code);
          })),
    );
  $("#mappingImport").onclick = () =>
    safe(async () => {
      const [file] = await filePick();
      if (!file) return;
      const sheet = await readExcel(file),
        hi = sheet.findIndex(
          (r) =>
            r.some((v) => /客戶品名/.test(String(v))) &&
            r.some((v) => /忠欣料號/.test(String(v))),
        );
      if (hi < 0) throw Error("需要「客戶品名」與「忠欣料號」標題。");
      const h = sheet[hi].map(String),
        ni = h.findIndex((v) => /客戶品名/.test(v)),
        ci = h.findIndex((v) => /忠欣料號/.test(v));
      const incoming = new Map(
        sheet
          .slice(hi + 1)
          .filter((r) => !r.hidden && r[ni] && r[ci])
          .map((r) => [String(r[ni]).trim(), String(r[ci]).trim()]),
      );
      if (!incoming.size) throw Error("沒有有效的對照資料。");
      if (
        !confirm(
          `此操作會取代該客戶全部 ${rows.length} 筆對照，改為 ${incoming.size} 筆。確定繼續？`,
        )
      )
        return;
      const ops = rows
        .filter((r) => !incoming.has(r.customer_name))
        .map((r) => ({
          kind: "mappings",
          id: r.id,
          data: r,
          revision: r.revision,
          remove: true,
        }));
      for (const [name, itemCode] of incoming) {
        const id = code + ":" + name,
          old = store.get("mappings", id);
        ops.push({
          kind: "mappings",
          id,
          data: {
            customer_code: code,
            customer_name: name,
            item_code: itemCode,
          },
          revision: old?.revision || 0,
        });
      }
      await store.batch(ops);
      toast("料號對照已整批更新");
      await mappingsModal(code);
    });
}
function filePick(accept = ".xlsx,.xls,.csv", multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...input.files]);
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}
async function importCustomers() {
  const [file] = await filePick();
  if (!file) return;
  const rows = await readExcel(file);
  const hi = rows.findIndex((r) => r.some((v) => /客戶代號/.test(String(v))));
  if (hi < 0) throw Error("找不到「客戶代號」標題欄。");
  const h = rows[hi].map(String),
    ci = h.findIndex((v) => /客戶代號/.test(v)),
    ni = h.findIndex((v) => /客戶名稱/.test(v));
  const incoming = rows
    .slice(hi + 1)
    .filter((r) => !r.hidden && String(r[ci] || "").trim());
  if (
    !confirm(
      `將匯入 ${incoming.length} 位客戶，已有代號會保留既有資料。是否繼續？`,
    )
  )
    return;
  let n = 0;
  for (const r of incoming) {
    const code = String(r[ci]).trim();
    if (store.get("customers", code)) continue;
    await store.mutate("customers", code, {
      code,
      name: String(r[ni] || code).trim(),
      group: "未分類",
      car_no: "",
      active: true,
      fixed: false,
      notes: "",
    });
    n++;
  }
  toast(`已新增 ${n} 位客戶`);
}
async function masterModal() {
  if (store.cloud) await store.loadAllSmall("master_items");
  openModal(
    "忠欣品項主檔",
    `<div class="form-note">Excel 標題需包含「料號」及「品名」。若未提供規格代號欄，保留既有值。</div><button class="btn primary" id="importMaster">↑ 匯入品項主檔</button><div class="table-wrap" style="margin-top:20px"><table><thead><tr><th>料號</th><th>品名</th><th>單位</th><th>規格代號</th><th>等級</th></tr></thead><tbody>${store
      .list("master_items")
      .map(
        (m) =>
          `<tr>${[m.item_code, m.item_name, m.unit, m.spec_code, m.grade].map((v) => `<td>${e(v)}</td>`).join("")}</tr>`,
      )
      .join("")}</tbody></table></div>`,
    true,
  );
  $("#importMaster").onclick = () =>
    safe(async () => {
      const [file] = await filePick();
      if (!file) return;
      const rows = await readExcel(file),
        hi = rows.findIndex(
          (r) =>
            r.some((v) => /料號|貨號/.test(String(v))) &&
            r.some((v) => /品名|品項名稱/.test(String(v))),
        );
      if (hi < 0) throw Error("找不到料號與品名標題。");
      const h = rows[hi].map(String),
        ix = (rx) => h.findIndex((v) => rx.test(v)),
        ci = ix(/料號|貨號/),
        ni = ix(/品名|品項名稱/),
        ui = ix(/單位/),
        si = ix(/規格代號/),
        gi = ix(/等級/);
      for (const r of rows.slice(hi + 1)) {
        if (r.hidden || !r[ci]) continue;
        const id = String(r[ci]).trim(),
          old = store.get("master_items", id);
        await store.mutate(
          "master_items",
          id,
          {
            item_code: id,
            item_name: String(r[ni] || ""),
            unit: String(r[ui] || ""),
            spec_code: si < 0 ? old?.spec_code || "" : String(r[si] || ""),
            grade: gi < 0 ? old?.grade || "" : String(r[gi] || ""),
          },
          { revision: old?.revision || 0 },
        );
      }
      toast("品項主檔已匯入");
      await masterModal();
    });
}
async function openWizard(code) {
  const c = customers().find((c) => c.code === code),
    p = profile(c);
  const previous = await fetchDetail("quote_items", code),
    mappings = await fetchDetail("mappings", code);
  if (store.cloud) await store.loadAllSmall("master_items");
  wizard = {
    code,
    p,
    step: 0,
    files: [],
    rows: [],
    map: p.mapping?.columns || [],
    start: p.mapping?.start ?? 1,
    previous,
    lookup: Object.fromEntries(
      mappings.map((m) => [m.customer_name, m.item_code]),
    ),
    dirty: false,
  };
  wizardRender();
}
function wizardRender() {
  const w = wizard;
  openModal(
    "匯入報價單",
    `<div class="steps">${["上傳檔案", "欄位對應", "預覽與儲存"].map((s, i) => `<span class="${i === w.step ? "active" : ""}">${i + 1} ${s}</span>`).join("")}</div><p class="subtle" style="margin-bottom:16px">${e(customers().find((c) => c.code === w.code)?.name)} · ${w.p.mode}</p>${
      w.step === 0
        ? `<label class="dropzone" id="quoteDrop"><span style="font-size:30px">▧</span><strong>將報價單拖曳至此，或點擊選擇</strong><span style="font-size:11px">Excel / CSV · 可多選，所有檔案必須使用相同格式</span><input id="quoteFiles" type="file" accept=".xlsx,.xls,.csv" multiple hidden></label><div id="fileList" style="margin-top:15px">${w.files.map((f) => `<span class="badge">${e(f.name)}</span>`).join(" ")}</div>`
        : w.step === 1
          ? `<div class="form-note">以第一個檔案設定欄位。同一類欄位可重複指定；每遇到新的${w.p.mode === "無貨號" ? "品名" : "貨號"}欄會建立一組。隱藏列自動排除。</div><label class="field">資料起始列<input type="number" id="startRow" value="${w.start + 1}" min="1" max="${w.rows[0].length}"></label><div class="mapping-grid">${Array.from({ length: Math.max(...w.rows[0].slice(0, 10).map((r) => r.length)) }, (_, i) => select(`第 ${i + 1} 欄 · ${e(w.rows[0][Math.max(0, w.start - 1)]?.[i] || "無標題")}`, `col${i}`, ["", ...fields], w.map[i] || "", `data-map="${i}"`)).join("")}</div><div class="table-wrap"><table><tbody>${w.rows[0]
              .slice(0, 8)
              .map(
                (r, i) =>
                  `<tr><td>${i + 1}</td>${r.map((v) => `<td>${e(v)}</td>`).join("")}</tr>`,
              )
              .join("")}</tbody></table></div>`
          : `<div class="result-summary"><span>共 <strong>${w.items.length}</strong> 項</span><span>新品 ${w.items.filter((i) => i.new).length} 項</span><span>未匹配 ${w.items.filter((i) => i.unmatched).length} 項</span></div><div class="table-wrap"><table class="result-table"><thead><tr><th>貨號／忠欣料號</th><th>品名</th><th>單位</th><th>單價</th><th>狀態</th></tr></thead><tbody>${w.items.map((i, n) => `<tr class="${i.unmatched ? "unmatched" : i.new ? "new" : ""}"><td>${w.p.mode === "無貨號" ? `<input aria-label="${e(i.品名)} 忠欣料號" data-item-code="${n}" value="${e(i.忠欣料號)}" list="masterCodes">` : e(i.貨號)}</td><td>${e(i.品名)}</td><td>${e(i.單位)}</td><td>${i.單價}</td><td>${i.unmatched ? "未匹配" : i.new ? "新增品項" : "已匹配"}</td></tr>`).join("")}</tbody></table></div><datalist id="masterCodes">${store
              .list("master_items")
              .map(
                (m) =>
                  `<option value="${e(m.item_code)}">${e(m.item_name)}</option>`,
              )
              .join(
                "",
              )}</datalist><p class="subtle" style="margin-top:15px">儲存只更新暫存報價，不會立即下載檔案。勾選客戶後可批次匯出。</p>`
    }<div class="form-actions"><button class="btn" data-action="${w.step ? "wizard-back" : "close-modal"}">${w.step ? "上一步" : "取消"}</button><button class="btn primary" data-action="${w.step === 2 ? "wizard-save" : "wizard-next"}">${w.step === 2 ? "儲存報價" : "下一步 →"}</button></div>`,
    true,
  );
  if (w.step === 0) {
    $("#quoteFiles").onchange = (ev) =>
      safe(() => wizardFiles([...ev.target.files]));
    $("#quoteDrop").ondragover = (ev) => ev.preventDefault();
    $("#quoteDrop").ondrop = (ev) => {
      ev.preventDefault();
      safe(() => wizardFiles([...ev.dataTransfer.files]));
    };
  }
  if (w.step === 2)
    $("#modalBody")
      .querySelectorAll("[data-item-code]")
      .forEach(
        (input) =>
          (input.oninput = () => {
            const i = w.items[Number(input.dataset.itemCode)];
            i.忠欣料號 = input.value.trim();
            const m = store
              .list("master_items")
              .find((m) => m.item_code === i.忠欣料號);
            i.unmatched = !m;
            if (m) i.單位 = m.unit;
          }),
      );
}
async function wizardFiles(files) {
  const rows = [];
  for (const f of files) rows.push(await readExcel(f));
  wizard.files = files;
  wizard.rows = rows;
  wizard.dirty = true;
  toast(`已讀取 ${files.length} 個檔案`);
  wizardRender();
}
function wizardNext() {
  const w = wizard;
  if (w.step === 0) {
    if (!w.files.length) throw Error("請先選擇報價單檔案。");
    if (!w.map.length) {
      const hi = w.rows[0].findIndex((r) =>
        r.some((v) => /品名|商品名稱|貨號|料號/.test(String(v))),
      );
      w.start = Math.max(1, hi + 1);
      w.map = guess(w.rows[0][Math.max(0, hi)] || [], w.p.mode);
    }
    w.step = 1;
  } else {
    w.start = Number($("#startRow").value) - 1;
    w.map = [...$("#modalBody").querySelectorAll("[data-map]")].map(
      (s) => s.value,
    );
    const identity = w.p.mode === "無貨號" ? "品名" : "貨號";
    if (!w.map.includes(identity) || !w.map.includes("單價"))
      throw Error(`至少需要設定${identity}及單價欄位。`);
    const previous = w.previous.map((x) => x.item[identity]);
    w.items = w.rows.flatMap((rows) =>
      convert(
        rows,
        w.map,
        w.start,
        w.p.mode,
        previous,
        w.lookup,
        store.list("master_items"),
      ),
    );
    if (!w.items.length)
      throw Error("沒有可儲存的品項，請確認起始列與欄位對應。");
    w.step = 2;
  }
  wizardRender();
}
async function saveWizard() {
  const w = wizard,
    button = $('[data-action="wizard-save"]');
  button.disabled = true;
  try {
    await saveQuoteData(w.code, w.p, w.previous, w.items, w.map, w.start);
    w.dirty = false;
    closeModal();
    toast("報價單已儲存，可勾選客戶匯出");
  } finally {
    button.disabled = false;
  }
}
async function exportQuotes() {
  const cs = customers().filter((c) => state.selected.has(c.code));
  if (!cs.length) throw Error("請先勾選可匯出的客戶。");
  let items = [];
  for (const c of cs) items.push(...(await fetchDetail("quote_items", c.code)));
  if (store.cloud) await store.loadAllSmall("master_items");
  const name = `忠欣報價-${state.date}.xlsx`,
    wb = await quoteWorkbook(
      cs,
      cs.map(profile),
      items,
      store.list("master_items"),
    );
  const ok = await saveWorkbook(wb, name);
  if (!ok) return;
  if (
    !window.showSaveFilePicker &&
    !confirm(
      "檔案已交付瀏覽器下載。請確認下載成功後按「確定」標記已匯出；尚未成功請按「取消」。",
    )
  )
    return;
  for (const c of cs) {
    const p = profile(c);
    await store.mutate(
      "profiles",
      p.id,
      {
        ...p,
        exported: true,
        last_export_time: new Date().toISOString(),
        last_export_filename: name,
        last_export_item_count: items.filter((i) => i.customer_code === c.code)
          .length,
      },
      { revision: p.revision },
    );
  }
  state.selected.clear();
  render();
  toast(
    window.showSaveFilePicker
      ? "報價單已儲存，匯出狀態已更新"
      : "已交付瀏覽器下載；請確認下載完成",
  );
}
async function exportOrders() {
  const wb = await workbook(),
    s = wb.addWorksheet("每日叫貨紀錄");
  s.addRow([
    "日期",
    "客戶代號",
    "客戶名稱",
    "車號",
    "狀態",
    "固定叫貨",
    "更新時間",
  ]);
  for (const o of store.list(
    "orders",
    (o) => state.page === "history" || o.date === state.date,
  )) {
    const c = customers().find((c) => c.code === o.customer_code);
    s.addRow([
      o.date,
      o.customer_code,
      c?.name || "",
      c?.car_no || "",
      { pending: "待叫貨", ordered: "已叫貨", off: "不叫貨" }[o.status],
      o.fixed ? "是" : "否",
      o.at,
    ]);
  }
  styleSheet(s, [16, 18, 28, 14, 14, 12, 28]);
  if (await saveWorkbook(wb, `叫貨紀錄-${state.date}.xlsx`))
    toast("Excel 已產生");
}
function download(text, name, type) {
  const u = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
async function restore() {
  if (store.cloud) throw Error("還原只適用本機模式。");
  const [f] = await filePick(".json");
  if (!f) return;
  const data = JSON.parse(await f.text());
  if (
    data.version !== 1 ||
    !Array.isArray(data.rows) ||
    data.rows.some((r) => !r.id || !r.kind || typeof r.data !== "object")
  )
    throw Error("備份格式不正確。");
  if (!confirm("將取代此瀏覽器的本機資料，建議先備份。是否繼續？")) return;
  store.rows = data.rows;
  store.persist();
  store.emit();
  toast("本機備份已還原");
}
async function allReportRows() {
  if (store.cloud) {
    let before = null,
      rows;
    do {
      rows = await store.load(state.report, {
        day: state.date,
        before,
        limit: 50,
      });
      before = rows.at(-1)?.id;
    } while (rows.length === 50);
  }
  return store
    .list(state.report, (r) => r.date === state.date)
    .sort((a, b) => b.id.localeCompare(a.id));
}
function printPreview() {
  const rows = store.list(state.report, (r) => r.date === state.date);
  if (!rows.length) throw Error("目前沒有可列印的紀錄。");
  const ab = state.report === "abnormal",
    pages = [];
  if (ab) {
    for (let offset = 0; offset < rows.length; offset += 16) {
      const values = Array.from({ length: 16 }, (_, i) =>
        rows[offset + i] ? reportValues(rows[offset + i]) : Array(8).fill(""),
      );
      pages.push(
        `<section class="print-page"><h2 contenteditable="true">忠欣蔬果有限公司</h2><h3 contenteditable="true">每日交接事件一覽表</h3><div class="legend" contenteditable="true">${e(categories.join("　"))}</div>${printTable(reportHeaders, values, [6, 5, 12, 6, 28, 8, 9, 26])}</section>`,
      );
    }
  } else {
    pages.push(
      `<section class="print-page"><h2 contenteditable="true">${md(state.date)}交接事項</h2>${printTable(
        ["客戶名稱＋車號", "事項"],
        Array.from({ length: Math.max(18, rows.length) }, (_, i) =>
          rows[i] ? [rows[i].store, rows[i].content] : ["", ""],
        ),
        [15, 85],
      )}</section>`,
    );
  }
  openModal(
    "列印預覽",
    `<div class="print-tools"><label>字級 <select id="printSize">${Array.from({ length: 12 }, (_, i) => `<option ${i + 9 === 11 ? "selected" : ""}>${i + 9}</option>`).join("")}</select> pt</label><label>字型 <select id="printFont">${["微軟正黑體", "標楷體", "新細明體", "蘋方-繁", "Arial"].map((f) => `<option>${f}</option>`).join("")}</select></label><button class="btn primary small" data-action="do-print">列印</button><span class="subtle">可直接編輯儲存格、拖曳欄寬與列高；不會寫回資料庫。</span></div><div id="printPages">${pages.join("")}</div>`,
    true,
  );
  $("#printSize").onchange = () =>
    $("#printPages")
      .querySelectorAll("table")
      .forEach((t) => (t.style.fontSize = $("#printSize").value + "pt"));
  $("#printFont").onchange = () =>
    $("#printPages")
      .querySelectorAll(".print-page")
      .forEach(
        (t) =>
          (t.style.fontFamily = {
            微軟正黑體: "Microsoft JhengHei",
            標楷體: "DFKai-SB",
            新細明體: "PMingLiU",
            "蘋方-繁": "PingFang TC",
            Arial: "Arial",
          }[$("#printFont").value]),
      );
  $("#printPages")
    .querySelectorAll(".resize-handle,.row-resize")
    .forEach(
      (handle) =>
        (handle.onpointerdown = (ev) => {
          ev.preventDefault();
          const cell = handle.parentElement,
            row = cell.parentElement,
            table = cell.closest("table"),
            startX = ev.clientX,
            startY = ev.clientY,
            w = cell.getBoundingClientRect().width,
            h = row.getBoundingClientRect().height;
          handle.setPointerCapture(ev.pointerId);
          const move = (evt) => {
            if (handle.classList.contains("row-resize"))
              row.style.height = Math.max(24, h + evt.clientY - startY) + "px";
            else {
              const col = table.querySelectorAll("col")[cell.cellIndex];
              col.style.width =
                Math.max(
                  3,
                  ((w + evt.clientX - startX) /
                    table.getBoundingClientRect().width) *
                    100,
                ) + "%";
            }
          };
          handle.onpointermove = move;
          handle.onpointerup = () => {
            handle.onpointermove = null;
          };
        }),
    );
}
function printTable(h, values, widths) {
  return `<table><colgroup>${widths.map((w) => `<col style="width:${w}%">`).join("")}</colgroup><thead><tr>${h.map((t) => `<th><span contenteditable="true">${e(t)}</span><span class="resize-handle" aria-hidden="true"></span></th>`).join("")}</tr></thead><tbody>${values.map((row) => `<tr style="height:33px">${row.map((v, i) => `<td><div contenteditable="true" style="min-height:24px">${e(v)}</div>${i === 0 ? '<span class="row-resize" aria-hidden="true"></span>' : ""}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
$("#modal").addEventListener("cancel", (ev) => {
  ev.preventDefault();
  closeModal();
});
await route();
await safe(async () => {
  if (await store.initCloud()) await loadPage();
});

async function saveQuoteData(code, p, previous, items, map, start) {
  const operations = previous.map((old) => ({
    kind: "quote_items",
    id: old.id,
    data: old,
    revision: old.revision,
    remove: true,
  }));
  const seenMappings = new Set();
  for (const item of items) {
    operations.push({
      kind: "quote_items",
      id: uid(),
      data: { customer_code: code, item },
    });
    if (p.mode === "無貨號" && item.忠欣料號 && !seenMappings.has(item.品名)) {
      seenMappings.add(item.品名);
      const id = code + ":" + item.品名,
        old = store.get("mappings", id);
      operations.push({
        kind: "mappings",
        id,
        data: {
          customer_code: code,
          customer_name: item.品名,
          item_code: item.忠欣料號,
        },
        revision: old?.revision || 0,
      });
    }
  }
  operations.push({
    kind: "profiles",
    id: code,
    data: {
      ...p,
      mapping: { start: start, columns: map },
      item_count: items.length,
      last_upload: new Date().toISOString(),
      exported: false,
    },
    revision: p.revision,
  });
  await store.batch(operations);
}

function manualTrend() {
  const rows = store
    .list("manual")
    .sort((a, b) => b.date.localeCompare(a.date));
  openModal(
    "手動趨勢資料",
    `<div class="form-note">保留人工核對數字，不覆寫每日客戶叫貨紀錄。</div><form id="manualForm"><div class="form-grid">${field("日期", "date", state.date, "date", "required")}${field("已叫貨客戶數", "count", 0, "number", 'required min="0" max="10000"')}${area("核對備註", "note")}</div>${formButtons()}</form><div class="table-wrap" style="margin-top:20px"><table><thead><tr><th>日期</th><th>人工筆數</th><th>備註</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${e(r.date)}</td><td>${r.count}</td><td>${e(r.note)}</td></tr>`).join("")}</tbody></table></div>`,
  );
}
let batchFiles = [];
function batchQuoteModal() {
  batchFiles = [];
  openModal(
    "批次匯入客戶報價",
    `<div class="form-note">依檔名比對客戶代號或名稱，並套用各客戶已儲存的欄位範本。不明確的檔名會要求確認，不會盲目合併。可累加選檔。</div><div class="actions"><label class="btn">＋ 選擇檔案<input type="file" id="batchFiles" accept=".xlsx,.xls,.csv" multiple hidden></label><label class="btn">選擇資料夾<input type="file" id="batchFolder" webkitdirectory multiple hidden></label></div><div id="batchList" style="margin-top:20px"></div><progress id="batchProgress" value="0" max="1" style="width:100%;margin-top:20px"></progress><div class="form-actions"><button class="btn" data-action="close-modal">關閉</button><button class="btn primary" id="batchRun">開始匯入</button></div>`,
    true,
  );
  const add = (files) => {
    for (const file of files) {
      if (
        !/\.(xlsx|xls|csv)$/i.test(file.name) ||
        batchFiles.some(
          (x) => x.file.name === file.name && x.file.size === file.size,
        )
      )
        continue;
      const name = file.name.replace(/\.[^.]+$/, "");
      const exact = customers().filter(
          (c) => c.code === name || c.name === name,
        ),
        matches = exact.length
          ? exact
          : customers().filter(
              (c) => name.includes(c.code) || name.includes(c.name),
            );
      batchFiles.push({
        file,
        code: matches.length === 1 ? matches[0].code : "",
        status: "待處理",
      });
    }
    renderBatchList();
  };
  $("#batchFiles").onchange = (ev) => add([...ev.target.files]);
  $("#batchFolder").onchange = (ev) => add([...ev.target.files]);
  $("#batchRun").onclick = () =>
    safe(async () => {
      if (!batchFiles.length) throw Error("請先選擇檔案。");
      if (batchFiles.some((x) => !x.code))
        throw Error("請先為每個檔案選擇客戶。");
      if (new Set(batchFiles.map((x) => x.code)).size !== batchFiles.length)
        throw Error(
          "每位客戶一次只能匯入一個檔案；相同客戶多檔請使用三步精靈。",
        );
      const button = $("#batchRun");
      button.disabled = true;
      try {
        let done = 0;
        for (const entry of batchFiles) {
          try {
            const c = customers().find((c) => c.code === entry.code),
              p = profile(c);
            if (!p.mapping) throw Error("尚未設定欄位範本");
            entry.status = "讀取中";
            renderBatchList();
            const rows = await readExcel(entry.file),
              previous = await fetchDetail("quote_items", entry.code),
              mappings = await fetchDetail("mappings", entry.code);
            if (store.cloud && !store.loaded.has("master_items"))
              await store.loadAllSmall("master_items");
            const items = convert(
              rows,
              p.mapping.columns,
              p.mapping.start,
              p.mode,
              previous.map(
                (x) => x.item[p.mode === "無貨號" ? "品名" : "貨號"],
              ),
              Object.fromEntries(
                mappings.map((m) => [m.customer_name, m.item_code]),
              ),
              store.list("master_items"),
            );
            if (!items.length) throw Error("沒有有效品項");
            await saveQuoteData(
              entry.code,
              p,
              previous,
              items,
              p.mapping.columns,
              p.mapping.start,
            );
            entry.status = `已儲存 ${items.length} 項`;
          } catch (err) {
            entry.status = "失敗：" + err.message;
          }
          done++;
          $("#batchProgress").value = done / batchFiles.length;
          renderBatchList();
        }
        toast("批次處理完成，請確認各檔案結果");
      } finally {
        button.disabled = false;
      }
    });
}
function renderBatchList() {
  $("#batchList").innerHTML =
    `<div class="table-wrap"><table><thead><tr><th>檔案</th><th>客戶</th><th>結果</th></tr></thead><tbody>${batchFiles
      .map(
        (entry, i) =>
          `<tr><td>${e(entry.file.name)}</td><td><select data-batch-customer="${i}"><option value="">請選擇客戶</option>${customers()
            .map(
              (c) =>
                `<option value="${e(c.code)}" ${entry.code === c.code ? "selected" : ""}>${e(c.code + " · " + c.name)}</option>`,
            )
            .join("")}</select></td><td>${e(entry.status)}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  $("#batchList")
    .querySelectorAll("[data-batch-customer]")
    .forEach(
      (input) =>
        (input.onchange = () =>
          (batchFiles[Number(input.dataset.batchCustomer)].code = input.value)),
    );
}

function batchEditModal() {
  openModal(
    "批次修改報價設定",
    `<form id="batchProfileForm"><div class="form-note">將套用至本期清單中的 ${state.selected.size} 位客戶。</div><div class="form-grid">${select(
      "報價週期",
      "cycle",
      [
        ["", "保持不變"],
        ["7", "7 天"],
        ["10", "10 天"],
        ["15", "15 天"],
        ["30", "30 天"],
      ],
    )}${select(
      "單位",
      "unit",
      [
        ["keep", "保持不變"],
        ["", "未設定"],
        ["kg", "kg"],
        ["台斤", "台斤"],
      ],
      "keep",
    )}</div>${formButtons()}</form>`,
  );
}
async function aliasesModal(code) {
  const rows = await fetchDetail("aliases", code);
  openModal(
    "客戶歷史別名",
    `<div class="form-note">${e(customers().find((c) => c.code === code)?.name)} · ${e(code)}<br>別名不會自動合併重名客戶；有歧義時仍需人工選擇。</div><form id="aliasForm" data-code="${e(code)}">${field("新增別名", "alias_name", "", "text", 'required maxlength="150"')}${formButtons("新增別名")}</form><div style="margin-top:20px">${rows.map((r) => `<div class="tray-row"><span>${e(r.alias_name)}</span><button class="text-link" data-delete-alias="${e(r.id)}">刪除</button></div>`).join("")}</div>`,
  );
  $("#modalBody")
    .querySelectorAll("[data-delete-alias]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          safe(async () => {
            const r = store.get("aliases", b.dataset.deleteAlias);
            if (!confirm("刪除此別名？")) return;
            await store.mutate("aliases", r.id, r, {
              revision: r.revision,
              remove: true,
            });
            await aliasesModal(code);
          })),
    );
}
