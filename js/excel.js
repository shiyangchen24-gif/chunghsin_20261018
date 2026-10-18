import { loadScript } from "./store.js?v=1.1.0";
export const fields = [
  "貨號",
  "品名",
  "單位",
  "單價",
  "備註",
  "產區品種",
  "裝箱方式",
  "包裝資材",
  "產地",
  "不報價原因",
  "變價原因",
];
export const headers = [
  "*客戶代號",
  "客戶名稱",
  "*客戶貨號",
  "客戶商品名稱",
  "客戶規格單位",
  "*單價",
  "備註",
  "產區/品種",
  "裝箱方式",
  "包裝資材",
  "產地",
  "不報價原因",
  "變價原因",
];
export function numeric(v) {
  const s = String(v ?? "")
    .trim()
    .replace(/[,，$＄￥¥\s元]/g, "")
    .replace(/^\((.*)\)$/, "-$1");
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw Error(`無法辨識單價：${v}`);
  return n;
}
export function guess(row, mode = "有貨號") {
  return row.map((v, i) => {
    const s = String(v ?? "").trim();
    if (fields.includes(s)) return s;
    if (s === "產區/品種") return "產區品種";
    if (/貨號|料號|品項代號/.test(s)) return "貨號";
    if (/品名|商品名稱|品項名稱/.test(s)) return "品名";
    if (/單價|價格|報價/.test(s)) return "單價";
    if (/單位|規格單位/.test(s)) return "單位";
    if (/備註/.test(s)) return "備註";
    if (!s && i > 0 && /品名|貨號|料號|商品名稱/.test(String(row[i - 1])))
      return "單價";
    return fields.includes(s) ? s : "";
  });
}
export function convert(
  rows,
  map,
  start,
  mode,
  previous = [],
  lookup = {},
  master = [],
) {
  const identity = mode === "無貨號" ? "品名" : "貨號";
  const groups = [];
  let g = {};
  for (let i = 0; i < map.length; i++) {
    if (!map[i]) continue;
    if (map[i] === identity && g[identity] !== undefined) {
      groups.push(g);
      g = {};
    }
    g[map[i]] = i;
  }
  if (Object.keys(g).length) groups.push(g);
  const out = [];
  for (let ri = start; ri < rows.length; ri++) {
    const row = rows[ri];
    if (row.hidden) continue;
    for (const group of groups) {
      const value = String(row[group[identity]] ?? "").trim();
      if (!value) continue;
      const item = Object.fromEntries(
        fields.map((f) => [
          f,
          group[f] === undefined ? "" : String(row[group[f]] ?? "").trim(),
        ]),
      );
      item.單價 = numeric(item.單價);
      if (item.單價 !== 0) item.不報價原因 = "";
      item.new = previous.length > 0 && !previous.includes(value);
      if (mode === "無貨號") {
        item.忠欣料號 = lookup[item.品名] || "";
        const m = master.find((m) => m.item_code === item.忠欣料號);
        if (m) item.單位 = m.unit;
        item.unmatched = !m;
      }
      out.push(item);
    }
  }
  return out.sort(
    (a, b) =>
      Number(a.unmatched) - Number(b.unmatched) ||
      Number(a.new) - Number(b.new),
  );
}
export async function readExcel(file) {
  await loadScript(
    "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  );
  const csv = /\.csv$/i.test(file.name);
  const wb = window.XLSX.read(
    csv ? await file.text() : await file.arrayBuffer(),
    {
      type: csv ? "string" : "array",
      cellStyles: true,
      raw: csv,
      codepage: 65001,
    },
  );
  const sheet = wb.Sheets[wb.SheetNames[0]],
    rows = window.XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: true,
      raw: false,
    });
  rows.forEach((r, i) => {
    r.hidden = !!sheet["!rows"]?.[i]?.hidden;
  });
  return rows;
}
export async function workbook() {
  await loadScript(
    "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js",
  );
  return new window.ExcelJS.Workbook();
}
export function styleSheet(sheet, widths) {
  sheet.columns = widths.map((width) => ({ width }));
  sheet.eachRow((row) =>
    row.eachCell({ includeEmpty: true }, (c) => {
      c.font = { name: "微軟正黑體", size: 11 };
      c.alignment = {
        vertical: "middle",
        horizontal: "center",
        wrapText: true,
      };
      c.border = Object.fromEntries(
        ["top", "left", "bottom", "right"].map((x) => [
          x,
          { style: "thin", color: { argb: "FF000000" } },
        ]),
      );
    }),
  );
  sheet.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: {
      left: 0.25,
      right: 0.25,
      top: 0.75,
      bottom: 0.75,
      header: 0.3,
      footer: 0.3,
    },
  };
}
export async function saveWorkbook(wb, name) {
  const buffer = await wb.xlsx.writeBuffer();
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          {
            description: "Excel",
            accept: {
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
                [".xlsx"],
            },
          },
        ],
      });
      const w = await h.createWritable();
      await w.write(buffer);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === "AbortError") return false;
      throw e;
    }
  }
  const url = URL.createObjectURL(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
export async function quoteWorkbook(customers, profiles, items, master) {
  const wb = await workbook(),
    modes = new Set(profiles.map((p) => p.mode));
  if (modes.size > 1) throw Error("有貨號與無貨號客戶請分開匯出。");
  if (profiles[0]?.mode === "無貨號") {
    const units = new Set(profiles.map((p) => p.unit).filter(Boolean));
    if (units.size > 1) throw Error("kg 與台斤客戶不可合併匯出，請分開勾選。");
    const s = wb.addWorksheet("多客戶報價單格式");
    s.addRow(["對象識別", "", "", "", "", ...customers.map(() => 1)]);
    s.addRow([
      "客戶代號",
      "",
      "",
      "",
      "",
      ...customers.map((c) => String(c.code)),
    ]);
    s.addRow([
      "品項代號",
      "品項名稱",
      "規格代號",
      "規格",
      "等級",
      ...customers.map((c) => c.name),
    ]);
    for (const m of master)
      s.addRow([
        m.item_code,
        m.item_name,
        m.spec_code,
        m.unit,
        m.grade,
        ...customers.map(
          (c) =>
            items.find(
              (x) =>
                x.customer_code === c.code && x.item.忠欣料號 === m.item_code,
            )?.item.單價 ?? "",
        ),
      ]);
    for (const x of items.filter(
      (x) => !master.some((m) => m.item_code === x.item.忠欣料號),
    )) {
      const r = s.addRow([
        "",
        x.item.品名,
        "",
        x.item.單位,
        "",
        ...customers.map((c) =>
          c.code === x.customer_code ? x.item.單價 : "",
        ),
      ]);
      r.eachCell(
        (cell) =>
          (cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFD9AD" },
          }),
      );
    }
    styleSheet(s, [
      23.875,
      31.125,
      11.375,
      9.625,
      14.125,
      ...customers.map(() => 18),
    ]);
    s.eachRow((r) =>
      r.eachCell(
        { includeEmpty: true },
        (c) => (c.font = { name: "微軟正黑體", size: 12 }),
      ),
    );
    for (let r = 1; r <= 3; r++)
      for (let c = 1; c <= 5; c++)
        s.getCell(r, c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFDEEBF7" },
        };
    for (let c = 6; c <= s.columnCount; c++) s.getCell(2, c).numFmt = "@";
    s.getColumn(1).numFmt = "@";
  } else {
    const s = wb.addWorksheet("匯入格式");
    s.addRow(headers);
    const newRows = [];
    for (const c of customers)
      for (const x of items.filter((i) => i.customer_code === c.code)) {
        const item = { ...x.item };
        if (numeric(item.單價) !== 0) item.不報價原因 = "";
        const r = s.addRow([
          String(c.code),
          c.name,
          ...fields.map((f) => item[f] ?? ""),
        ]);
        if (item.new) newRows.push(r);
      }
    styleSheet(s, [16, 24, 18, 28, 14, 12, 25, 16, 16, 16, 16, 20, 20]);
    [1, 3].forEach((n) => {
      s.getColumn(n).numFmt = "@";
      s.getColumn(n).alignment = {
        horizontal: "left",
        vertical: "middle",
        wrapText: true,
      };
    });
    s.getRow(1).font = { name: "微軟正黑體", size: 11, bold: true };
    for (const row of newRows)
      row.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFDE5A" },
        };
        cell.font = {
          name: "微軟正黑體",
          size: 11,
          color: { argb: "FFFF0000" },
        };
      });
  }
  return wb;
}
export const categories = [
  "A 品質",
  "B 送貨延遲（送錯貨）",
  "C 銷貨單、手抄單錯誤",
  "D 漏單",
  "E 未依客戶需求供貨",
  "F 銷貨單未送達（未簽名）",
  "G 交接事項",
  "H 收回退貨",
  "I 出貨數量異常",
];
export const reportHeaders = [
  "日期",
  "車號",
  "客戶名稱",
  "異常類別",
  "狀況說明",
  "處理方式",
  "責任歸屬",
  "補充說明",
];
export const md = (d) => {
  const a = String(d).split("-");
  return `${Number(a[1])}月${Number(a[2])}日`;
};
export const reportValues = (r) => [
  md(r.date),
  r.car_no,
  r.store,
  r.category?.charAt(0),
  r.reason,
  r.exchange_type,
  r.responsibility,
  r.note,
];
export async function reportWorkbook(type, rows, date) {
  const wb = await workbook(),
    s = wb.addWorksheet(type === "abnormal" ? "異常表" : "交接表");
  if (type === "abnormal") {
    s.addRow(["忠欣蔬果有限公司"]);
    s.mergeCells("A1:H1");
    s.addRow(["每日交接事件一覽表"]);
    s.mergeCells("A2:H2");
    s.addRow([categories.join("　")]);
    s.mergeCells("A3:H3");
    s.addRow(reportHeaders);
    for (let i = 0; i < Math.max(16, Math.ceil(rows.length / 16) * 16); i++)
      s.addRow(rows[i] ? reportValues(rows[i]) : Array(8).fill(""));
    styleSheet(s, [10.57, 6.43, 22.14, 6.57, 50.14, 11, 11.29, 35.43]);
    s.getRow(1).height = 22.15;
    s.getRow(2).height = 22.15;
    s.getRow(3).height = 33;
    s.getRow(4).height = 33;
    [14, 14, 11, 12].forEach(
      (size, i) => (s.getRow(i + 1).font = { name: "微軟正黑體", size }),
    );
    for (let i = 5; i <= s.rowCount; i++) {
      s.getRow(i).height = 24.75;
      if (i > 5 && (i - 5) % 16 === 0) s.getRow(i - 1).addPageBreak();
    }
    s.pageSetup.printTitlesRow = "1:4";
  } else {
    s.addRow([`${md(date)}交接事項`]);
    s.mergeCells("A1:B1");
    s.addRow(["客戶名稱＋車號", "事項"]);
    for (let i = 0; i < Math.max(18, rows.length); i++)
      s.addRow(rows[i] ? [rows[i].store, rows[i].content] : ["", ""]);
    styleSheet(s, [20.71, 133.57]);
    s.getRow(1).height = 30.75;
    s.getRow(1).font = { name: "微軟正黑體", size: 16, bold: true };
    s.getRow(2).height = 27.75;
    s.getRow(2).font = { name: "微軟正黑體", size: 14 };
    for (let i = 3; i <= s.rowCount; i++) {
      s.getRow(i).height = 26.25;
      s.getRow(i).font = { name: "微軟正黑體", size: 12 };
      s.getCell(i, 2).alignment = {
        horizontal: "left",
        vertical: "middle",
        wrapText: true,
      };
    }
    s.pageSetup.printTitlesRow = "1:2";
  }
  return wb;
}
