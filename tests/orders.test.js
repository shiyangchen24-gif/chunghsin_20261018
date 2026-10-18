import test from "node:test";
import assert from "node:assert/strict";
import {
  orderStatus,
  shiftDay,
  classify,
  dailyStatuses,
  monthSummary,
  normalizeTracking,
} from "../js/orders.js";
test("四狀態互斥、含當日三天、新客戶預設未叫貨", () => {
  assert.equal(
    orderStatus(undefined, "2026-10-18", "2026-10-18", null),
    "pending",
  );
  assert.equal(
    orderStatus(undefined, "2026-10-19", "2026-10-18", null),
    "pending",
  );
  assert.equal(
    orderStatus(undefined, "2026-10-20", "2026-10-18", null),
    "overdue",
  );
  assert.equal(orderStatus("off", "2026-10-20", "2026-10-01", null), "off");
  assert.equal(
    orderStatus("ordered", "2026-10-20", "2026-10-01", null),
    "ordered",
  );
  assert.equal(
    orderStatus("pending", "2026-10-20", "2026-10-01", "2026-10-18"),
    "pending",
  );
  assert.equal(
    orderStatus("pending", "2026-10-20", "2026-10-01", "2026-10-17"),
    "overdue",
  );
});
test("追蹤起日為一次性資料補值，既有狀態與未知欄位不丟失", () => {
  const rows = [
    {
      kind: "customers",
      id: "A",
      revision: 4,
      data: { code: "A", name: "A", unknown: 42 },
    },
    {
      kind: "orders",
      id: "day:A",
      data: { customer_code: "A", date: "2026-09-29", status: "ordered" },
    },
  ];
  const normalized = normalizeTracking(rows, "2026-10-18");
  assert.equal(normalized[0].data.tracking_since, "2026-09-29");
  assert.equal(normalized[0].revision, 4);
  assert.equal(normalized[0].data.unknown, 42);
  assert.equal(
    normalizeTracking(normalized, "2026-10-30")[0].data.tracking_since,
    "2026-09-29",
  );
  assert.equal(rows[0].data.tracking_since, undefined);
});
test("日統計與月份：跨月三天、狀態總和、未來不計入及系列可重疊", () => {
  const cs = [
    { code: "A", name: "A", group: "原系列", tracking_since: "2026-09-29" },
    { code: "B", name: "B", group: "原系列", tracking_since: "2026-10-02" },
  ];
  const records = [
    { date: "2026-09-30", customer_code: "A", status: "ordered" },
    { date: "2026-10-01", customer_code: "A", status: "off" },
    { date: "2026-10-03", customer_code: "B", status: "ordered" },
  ];
  const summary = monthSummary(
    cs,
    records,
    [{ id: "custom", name: "自訂", customer_codes: ["A"] }],
    "2026-10",
    "2026-10-03",
  );
  assert.equal(summary.days.length, 3);
  assert.equal(summary.days[0].total, 1);
  assert.deepEqual(summary.days[2], {
    date: "2026-10-03",
    ordered: 1,
    pending: 0,
    off: 0,
    overdue: 1,
    total: 2,
  });
  assert.equal(summary.counts.total, 5);
  assert.equal(summary.customers.find((c) => c.code === "B").total, 2);
  assert.equal(summary.series.find((g) => g.id === "custom").total, 3);
  for (const day of summary.days)
    assert.equal(day.ordered + day.pending + day.off + day.overdue, day.total);
  assert.equal(classify(cs[0], records, "2026-10-03", "2026-10-03"), "overdue");
  assert.equal(
    dailyStatuses(cs, records, "2026-10-03", "2026-10-03").get("B"),
    "ordered",
  );
  assert.equal(
    monthSummary(cs, records, [], "2026-11", "2026-10-03").days.length,
    0,
  );
  assert.equal(
    monthSummary(cs, records, [], "2024-02", "2026-10-03").days.length,
    29,
  );
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});
test("雲端摘要尚未載入不誤判三日未叫；到達摘要後再自動判別", () => {
  const cs = [{ code: "A", tracking_since: "2026-10-01" }];
  assert.equal(
    dailyStatuses(cs, [], "2026-10-18", "2026-10-18", null).get("A"),
    "pending",
  );
  assert.equal(
    dailyStatuses(cs, [], "2026-10-18", "2026-10-18", {
      A: { last_ordered_before: null },
    }).get("A"),
    "overdue",
  );
});
test("增量月摘要與完整重算一致，更新當天也會改變後兩天三日判斷", async () => {
  const { patchMonthSummary } = await import("../js/orders.js");
  const cs = [
    { code: "A", name: "A", group: "群組", tracking_since: "2026-10-01" },
    { code: "B", name: "B", group: "群組", tracking_since: "2026-10-01" },
  ];
  const groups = [{ id: "subset", name: "A系列", customer_codes: ["A"] }],
    original = monthSummary(cs, [], groups, "2026-10", "2026-10-05");
  const changed = monthSummary(
    cs,
    [{ customer_code: "A", date: "2026-10-03", status: "ordered" }],
    groups,
    "2026-10",
    "2026-10-05",
  );
  const patched = patchMonthSummary(original, [
    changed.customers.find((c) => c.code === "A"),
  ]);
  assert.deepEqual(patched, changed);
  assert.equal(original.days[2].overdue, 2);
  assert.equal(patched.days[2].overdue, 1);
  assert.equal(patched.days[4].overdue, 1);
});
