import { test, expect } from "@playwright/test";
async function seed(page) {
  await page.goto("http://127.0.0.1:5173");
  const dates = await page.evaluate(() => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const shift = (n) => {
      const d = new Date(today + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const cs = [
      ["A", "甲客戶", shift(-3)],
      ["B", "乙客戶", shift(-3)],
      ["C", "新客戶", today],
      ["D", "不叫貨客戶", shift(-3)],
      ["E", "已叫貨客戶", shift(-3)],
    ];
    const rows = cs.map(([code, name, tracking_since]) => ({
      kind: "customers",
      id: code,
      revision: 1,
      data: { code, name, tracking_since, active: true, group: "餐飲" },
    }));
    for (const [code, date, status] of [
      ["B", shift(-1), "ordered"],
      ["D", today, "off"],
      ["E", today, "ordered"],
    ])
      rows.push({
        kind: "orders",
        id: date + ":" + code,
        revision: 1,
        data: {
          customer_code: code,
          date,
          status,
          at: new Date().toISOString(),
        },
      });
    localStorage.setItem("chunghsin.workspace.v1", JSON.stringify(rows));
    return { today, month: today.slice(0, 7) };
  });
  await page.reload();
  return dates;
}
test("卡片預設與四狀態、整卡左鍵／右鍵、進度條及移除公告提醒", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await seed(page);
  await expect(page.locator('[data-order-card="A"]')).toHaveAttribute(
    "data-status",
    "overdue",
  );
  await expect(page.locator('[data-order-card="B"]')).toHaveAttribute(
    "data-status",
    "pending",
  );
  await expect(page.locator('[data-order-card="C"]')).toHaveAttribute(
    "data-status",
    "pending",
  );
  await expect(page.locator('[data-order-card="D"]')).toHaveAttribute(
    "data-status",
    "off",
  );
  await expect(page.locator('[data-order-card="E"]')).toHaveAttribute(
    "data-status",
    "ordered",
  );
  await expect(page.locator("#orderProgressText")).toHaveText(
    "已叫 1 家 ／ 總計 5 家",
  );
  await expect(page.getByText("今日公告", { exact: true })).toHaveCount(0);
  await expect(page.getByText("工作小提醒", { exact: true })).toHaveCount(0);
  await page.locator('[data-order-card="A"] h3').click();
  await expect(page.locator('[data-order-card="A"]')).toHaveAttribute(
    "data-status",
    "ordered",
  );
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "2",
  );
  await page.locator('[data-order-card="A"] h3').click({ button: "right" });
  await expect(page.locator('[data-order-card="A"]')).toHaveAttribute(
    "data-status",
    "off",
  );
  await expect(page.locator("#orderProgressText")).toHaveText(
    "已叫 1 家 ／ 總計 5 家",
  );
  await page.locator('[data-order-card="A"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-order-card="A"]')).toHaveAttribute(
    "data-status",
    "ordered",
  );
  await page.locator('[data-filter="overdue"]').click();
  await expect(page.locator(".customer-card")).toHaveCount(0);
  await page.locator('[data-filter="all"]').click();
  await page.reload();
  await expect(page.locator('[data-order-card="A"]')).toHaveAttribute(
    "data-status",
    "ordered",
  );
  expect(
    await page
      .locator(".order-progress-fill")
      .evaluate((el) => getComputedStyle(el, "::after").animationName),
  ).toBe("order-shine");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".order-progress-fill")
      .evaluate((el) => getComputedStyle(el, "::after").animationName),
  ).toBe("none");
  expect(errors).toEqual([]);
});
test("側欄完全隱藏／恢復與重載記憶，手機保留可操作切換鈕", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await page.getByRole("button", { name: "隱藏側欄", exact: true }).click();
  await expect(page.locator("#sidebar")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "顯示側欄", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(
    await page
      .locator(".app-shell")
      .evaluate((el) => getComputedStyle(el).marginLeft),
  ).toBe("0px");
  await page.reload();
  await expect(page.locator("#sidebar")).not.toBeVisible();
  await page.getByRole("button", { name: "顯示側欄", exact: true }).click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "隱藏側欄", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("Dashboard 月份／完整每日統計、系列選擇成員與日期鑽取", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { today, month } = await seed(page);
  await page.getByRole("link", { name: /Dashboard/ }).click();
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#dashboardMonth")).toHaveValue(month);
  const row = page
    .locator(".dashboard-table tbody tr")
    .filter({ has: page.getByRole("button", { name: today, exact: true }) });
  await expect(row).toHaveCount(1);
  expect(await row.locator("td").allTextContents()).toEqual([
    today,
    "1",
    "2",
    "1",
    "1",
    "5",
    "20%",
  ]);
  await page.getByRole("button", { name: "⚙ 設定系列", exact: true }).click();
  await page.locator('#seriesForm [name="name"]').fill("指定客戶系列");
  await page.locator('#seriesForm [value="A"]').check();
  await page.locator('#seriesForm [value="B"]').check();
  await page.getByRole("button", { name: "儲存系列", exact: true }).click();
  const custom = page.locator(".series-card").filter({
    has: page.getByRole("heading", { name: "指定客戶系列", exact: true }),
  });
  await expect(custom.locator(".badge")).toHaveText("2 家");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "指定客戶系列", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: today, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "每日打勾單", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#workDate")).toHaveValue(today);
  expect(errors).toEqual([]);
});

test("雲端介面模擬：單一客戶更新只讀取該客戶月摘要", async ({ page }) => {
  const { today } = await seed(page);
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js?v=1.1.0");
    const { monthSummary } = await import("/js/orders.js?v=1.1.0");
    let backend = structuredClone(store.rows);
    window.dashboardRpcCalls = [];
    store.cloud = true;
    store.role = "admin";
    store.loaded = new Set([
      "customers",
      "profiles",
      "vehicles",
      "groups",
      "manual",
    ]);
    const summary = (month) =>
      monthSummary(
        backend
          .filter((r) => r.kind === "customers" && !r.deleted)
          .map((r) => r.data),
        backend
          .filter((r) => r.kind === "orders" && !r.deleted)
          .map((r) => r.data),
        [],
        month,
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Taipei",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()),
      );
    store.rpc = async (name, args = {}) => {
      window.dashboardRpcCalls.push({ name, args });
      if (name === "month_dashboard") return summary(args.p_month);
      if (name === "dashboard_customers")
        return summary(args.p_month).customers.filter((c) =>
          args.p_codes.includes(c.code),
        );
      if (name === "write") {
        const row = {
          kind: args.p_kind,
          id: args.p_id,
          data: args.p_data,
          revision: args.p_expected + 1,
          deleted: false,
        };
        backend = backend.filter(
          (r) => !(r.kind === row.kind && r.id === row.id),
        );
        backend.push(row);
        return row;
      }
      if (name === "order_summary" || name === "order_summaries")
        return Object.fromEntries(
          backend
            .filter((r) => r.kind === "customers")
            .map((r) => [r.id, { last_ordered_before: null }]),
        );
      throw Error("非預期 RPC：" + name);
    };
  });
  await page.getByRole("link", { name: /Dashboard/ }).click();
  await expect(page.locator(".dashboard-table")).toBeVisible();
  const initialFull = await page.evaluate(
    () =>
      window.dashboardRpcCalls.filter((c) => c.name === "month_dashboard")
        .length,
  );
  await page.evaluate(async (day) => {
    const { store } = await import("/js/store.js?v=1.1.0");
    await store.mutate(
      "orders",
      day + ":A",
      {
        date: day,
        customer_code: "A",
        status: "ordered",
        at: new Date().toISOString(),
      },
      { revision: 0 },
    );
  }, today);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.dashboardRpcCalls.filter(
            (c) => c.name === "dashboard_customers",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  const calls = await page.evaluate(() => window.dashboardRpcCalls);
  expect(calls.filter((c) => c.name === "month_dashboard")).toHaveLength(
    initialFull,
  );
  expect(
    calls.find((c) => c.name === "dashboard_customers").args.p_codes,
  ).toEqual(["A"]);
  const row = page
    .locator(".dashboard-table tbody tr")
    .filter({ has: page.getByRole("button", { name: today, exact: true }) });
  await expect(row.locator("td").nth(1)).toHaveText("2");
  await expect(row.locator("td").nth(4)).toHaveText("0");
});

test("跨台北午夜自動切換當日，查看歷史日期時保留使用者選擇", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-20T15:59:30Z") });
  await seed(page);
  await expect(page.locator("#workDate")).toHaveValue("2026-10-20");
  await page.clock.runFor(60000);
  await expect(page.locator("#workDate")).toHaveValue("2026-10-21");
  await expect(page.locator("#orderProgressText")).toHaveText(
    "已叫 0 家 ／ 總計 5 家",
  );
  await page.locator("#workDate").fill("2026-10-10");
  await page.locator("#workDate").dispatchEvent("change");
  await page.clock.fastForward(86400000);
  await expect(page.locator("#workDate")).toHaveValue("2026-10-10");
});
