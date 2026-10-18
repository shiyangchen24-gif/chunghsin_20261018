import { test, expect } from "@playwright/test";
test("本機流程：示範、勾選、編輯回改、報表、重載保存", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await expect(
    page.getByRole("heading", { name: "每日打勾單", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "載入示範資料", exact: true }).click();
  await expect(page.locator(".customer-card")).toHaveCount(12);
  await page.locator('[data-check="DEMO006"]').click();
  await expect(page.locator('[data-check="DEMO006"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator('[data-edit-order="DEMO006"]').click();
  await page.locator("#orderForm select").selectOption("pending");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.locator('[data-check="DEMO006"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("link", { name: "異常與交接" }).click();
  await page.locator('#reportForm [name="store"]').fill("晶華酒店");
  await page
    .locator('#reportForm [name="reason"]')
    .fill("10/18 高麗菜 2箱 品質異常");
  await page.getByRole("button", { name: "＋ 新增異常紀錄" }).click();
  await expect(
    page.getByRole("cell", { name: "10/18 高麗菜 2箱 品質異常", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "▤ 列印 Excel" }).click();
  await expect(page.locator(".print-page tbody tr")).toHaveCount(16);
  await page.locator(".print-page tbody td div").first().fill("測試日期");
  await page.getByRole("button", { name: "關閉視窗" }).click();
  await expect(
    page.getByRole("cell", { name: "測試日期", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("cell", { name: "10/18 高麗菜 2箱 品質異常", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("客戶表單、XSS、搜尋與手機版無水平溢位", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: "＋ 新增客戶" }).click();
  await page.locator('#customerForm [name="code"]').fill("C001");
  await page
    .locator('#customerForm [name="name"]')
    .fill("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.locator(".customer-card h3")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  expect(await page.locator("main img").count()).toBe(0);
  await expect(page.locator(".customer-card")).toHaveCount(1);
  await page.locator("#search").fill("不存在");
  await expect(page.locator(".customer-card")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
test("報價三步匯入、品項儲存、Excel 精確欄位與取消匯出", async ({ page }) => {
  await page.route(
    "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    (r) =>
      r.fulfill({
        path: "node_modules/xlsx/dist/xlsx.full.min.js",
        contentType: "application/javascript",
      }),
  );
  await page.route(
    "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js",
    (r) =>
      r.fulfill({
        path: "node_modules/exceljs/dist/exceljs.min.js",
        contentType: "application/javascript",
      }),
  );
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: "載入示範資料", exact: true }).click();
  await page.getByRole("link", { name: "報價單管理" }).click();
  await page.locator('[data-wizard="DEMO001"]').click();
  await page.locator("#quoteFiles").setInputFiles({
    name: "demo.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      '\ufeff貨號,品名,單位,單價,不報價原因\n001,高麗菜,kg,"$1,200",不報\n002,白菜,kg,,\n',
    ),
  });
  await expect(page.locator("#fileList")).toContainText("demo.csv");
  await page.locator('[data-action="wizard-next"]').click();
  await page.locator('[data-action="wizard-next"]').click();
  await expect(page.locator(".result-table tbody tr")).toHaveCount(2);
  await page.locator('[data-action="wizard-save"]').click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await page.locator('[data-quote-select="DEMO001"]').check();
  await page.evaluate(() => {
    window.pickerCancelled = false;
    window.showSaveFilePicker = async () => {
      window.pickerCancelled = true;
      throw new DOMException("cancel", "AbortError");
    };
  });
  await page.locator('[data-action="export-quotes"]').click();
  await expect
    .poll(() => page.evaluate(() => window.pickerCancelled))
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("chunghsin.workspace.v1")).find(
          (r) => r.kind === "profiles" && r.id === "DEMO001",
        ).data.exported,
    ),
  ).toBe(false);
  await page.evaluate(() => {
    window.savedBuffer = null;
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (buffer) => {
          window.savedBuffer = Array.from(new Uint8Array(buffer));
        },
        close: async () => {},
      }),
    });
  });
  await page.locator('[data-action="export-quotes"]').click();
  await expect.poll(() => page.evaluate(() => !!window.savedBuffer)).toBe(true);
  const result = await page.evaluate(async () => {
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(new Uint8Array(window.savedBuffer));
    const s = wb.worksheets[0];
    return {
      name: s.name,
      cols: s.columnCount,
      price: s.getCell("F2").value,
      reason: s.getCell("L2").value,
      code: s.getCell("C2").value,
      numFmt: s.getCell("C2").numFmt,
    };
  });
  expect(result).toEqual({
    name: "匯入格式",
    cols: 13,
    price: 1200,
    reason: "",
    code: "001",
    numFmt: "@",
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("chunghsin.workspace.v1")).find(
            (r) => r.kind === "profiles" && r.id === "DEMO001",
          ).data.exported,
      ),
    )
    .toBe(true);
});

test("報表列下編輯與取消保留原始資料", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173/#reports");
  await page.locator('#reportForm [name="store"]').fill("測試客戶");
  await page.locator('#reportForm [name="reason"]').fill("原始異常");
  await page.getByRole("button", { name: "＋ 新增異常紀錄" }).click();
  await page.locator("[data-edit-report]").click();
  await page.locator('#editReportForm [name="reason"]').fill("修改後異常");
  await page.getByRole("button", { name: "儲存變更", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "修改後異常", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".inline-edit-row")).toHaveCount(0);
  await page.locator("[data-edit-report]").click();
  await page.locator('#editReportForm [name="reason"]').fill("取消的草稿");
  await page.locator('[data-action="cancel-inline"]').click();
  await expect(
    page.getByRole("cell", { name: "修改後異常", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "取消的草稿", exact: true }),
  ).toHaveCount(0);
});
