import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const admin = "00000000-0000-0000-0000-000000000001";
const viewer = "00000000-0000-0000-0000-000000000002";
let db;
async function setup() {
  if (db) return db;
  db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;insert into auth.users values('${admin}'),('${viewer}');`,
  );
  const migration = await readFile(
    new URL("../sql/01_workspace.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  const dashboard = await readFile(
    new URL("../sql/02_dashboard.sql", import.meta.url),
    "utf8",
  );
  await db.exec(dashboard);
  await db.exec(dashboard);
  await db.exec(
    `insert into cs_members values('${admin}','admin',true),('${viewer}','viewer',true);select set_config('request.jwt.claim.sub','${admin}',false);`,
  );
  return db;
}
const request = () => crypto.randomUUID();
async function write(kind, id, data, rev = 0, req = request(), del = false) {
  return (
    await db.query("select cs_write($1,$2,$3::jsonb,$4,$5::uuid,$6) as r", [
      kind,
      id,
      JSON.stringify(data),
      rev,
      req,
      del,
    ])
  ).rows[0].r;
}
test("migration 可重複執行；CAS、request_id、tombstone、成員權限", async () => {
  await setup();
  const req = request(),
    data = { code: "C001", name: "測試客戶", active: true };
  const a = await write("customers", "C001", data, 0, req);
  assert.equal(a.revision, 1);
  assert.deepEqual(await write("customers", "C001", data, 0, req), a);
  await assert.rejects(
    write("customers", "C001", { ...data, name: "覆寫" }, 0),
    /其他裝置/,
  );
  await write("orders", "2026-10-18:C001", {
    date: "2026-10-18",
    customer_code: "C001",
    status: "ordered",
  });
  let changes = (await db.query("select cs_changes(0) as r")).rows[0].r;
  assert.equal(changes.length, 2);
  assert.equal(changes[0].kind, "customers");
  assert.ok(!("data" in changes[0]));
  await write("customers", "C001", data, 1, request(), true);
  changes = (await db.query("select cs_changes(2) as r")).rows[0].r;
  assert.equal(changes[0].deleted, true);
  await db.exec(`select set_config('request.jwt.claim.sub','${viewer}',false)`);
  await assert.rejects(
    write("notices", "a", { title: "禁止" }),
    /沒有寫入權限/,
  );
  await db.exec(`select set_config('request.jwt.claim.sub','',false)`);
  await assert.rejects(db.query("select cs_watermark()"), /先登入/);
});
test("批次任一筆版本衝突整體回滾，viewer 可讀但不可直接寫表", async () => {
  await setup();
  await db.exec(`select set_config('request.jwt.claim.sub','${admin}',false)`);
  const data = { code: "C002", name: "第二位客戶" };
  await write("customers", "C002", data);
  const ops = [
    {
      kind: "notices",
      id: "batch-ok",
      data: { title: "應回滾" },
      expected: 0,
      request: request(),
      deleted: false,
    },
    {
      kind: "customers",
      id: "C002",
      data,
      expected: 0,
      request: request(),
      deleted: false,
    },
  ];
  await assert.rejects(
    db.query("select cs_batch($1::jsonb)", [JSON.stringify(ops)]),
    /其他裝置/,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from cs_notices where id='batch-ok'",
      )
    ).rows[0].n,
    0,
  );
  await db.exec(
    `select set_config('request.jwt.claim.sub','${viewer}',false);set role authenticated`,
  );
  assert.equal(
    (await db.query("select cs_get('customers','C002') as r")).rows[0].r.data
      .name,
    "第二位客戶",
  );
  await assert.rejects(
    db.query("insert into cs_notices(id,data) values('bad','{}')"),
    /permission denied/,
  );
  await db.exec("reset role");
});

test("Dashboard 月聚合與前端完全一致，跨月歷史、系列、四狀態及登入權限", async () => {
  await setup();
  await db.exec(`select set_config('request.jwt.claim.sub','${admin}',false)`);
  const { monthSummary } = await import("../js/orders.js");
  await write("customers", "D001", {
    code: "D001",
    name: "月報客戶",
    group: "飯店",
    active: true,
    tracking_since: "2026-09-29",
  });
  await write("customers", "D002", {
    code: "D002",
    name: "新客戶",
    group: "飯店",
    active: true,
    tracking_since: "2026-10-02",
  });
  await write("orders", "2026-09-30:D001", {
    date: "2026-09-30",
    customer_code: "D001",
    status: "ordered",
  });
  await write("orders", "2026-10-01:D001", {
    date: "2026-10-01",
    customer_code: "D001",
    status: "off",
  });
  await write("orders", "2026-10-03:D002", {
    date: "2026-10-03",
    customer_code: "D002",
    status: "ordered",
  });
  await write("groups", "custom-hotels", {
    name: "自訂飯店",
    customer_codes: ["D001", "D002"],
  });
  const data = (await db.query("select cs_month_dashboard('2026-10') as r"))
    .rows[0].r;
  const customers = (
    await db.query("select id,data from cs_customers where not deleted")
  ).rows.map((x) => ({ ...x.data, id: x.id }));
  const orders = (
    await db.query("select data from cs_orders where not deleted")
  ).rows.map((x) => x.data);
  const groups = (
    await db.query("select id,data from cs_groups where not deleted")
  ).rows.map((x) => ({ ...x.data, id: x.id }));
  const js = monthSummary(
    customers,
    orders,
    groups,
    "2026-10",
    (
      await db.query(
        "select (now() at time zone 'Asia/Taipei')::date::text as day",
      )
    ).rows[0].day,
  );
  assert.deepEqual(data.days, js.days);
  assert.deepEqual(data.counts, js.counts);
  assert.deepEqual(data.customers, js.customers);
  assert.deepEqual(
    data.series.find((x) => x.id === "custom-hotels"),
    js.series.find((x) => x.id === "custom-hotels"),
  );
  const partial = (
    await db.query(
      "select cs_dashboard_customers('2026-10',array['D001','D002']) as r",
    )
  ).rows[0].r;
  for (const row of partial)
    assert.deepEqual(
      row,
      data.customers.find((c) => c.code === row.code),
    );
  const summary = (await db.query("select cs_order_summary('2026-10-02') as r"))
    .rows[0].r;
  const single = (
    await db.query("select cs_order_summaries('2026-10-02',array['D001']) as r")
  ).rows[0].r;
  assert.deepEqual(single, { D001: summary.D001 });
  assert.equal(summary.D001.last_ordered_before, "2026-09-30");
  assert.equal(
    (await db.query("select cs_warn3('2026-10-03') as r")).rows[0].r.includes(
      "D001",
    ),
    true,
  );
  assert.equal(
    (await db.query("select cs_warn3('2026-10-01') as r")).rows[0].r.includes(
      "D001",
    ),
    false,
  );
  await db.exec(
    `select set_config('request.jwt.claim.sub','${viewer}',false);set role authenticated`,
  );
  await db.query("select cs_month_dashboard('2026-10')");
  await db.exec(
    `reset role;select set_config('request.jwt.claim.sub','',false)`,
  );
  await assert.rejects(
    db.query("select cs_month_dashboard('2026-10')"),
    /先登入/,
  );
});

test("02 升級補值保留既有資料、通知只產生一次，重跑不再增加版本", async () => {
  await setup();
  await db.exec(
    `select set_config('request.jwt.claim.sub','${admin}',false);drop trigger cs_customer_tracking on cs_customers;`,
  );
  await db.query(
    "insert into cs_customers(id,data,revision) values('LEGACY',$1::jsonb,8)",
    [
      JSON.stringify({
        code: "LEGACY",
        name: "舊客戶",
        active: true,
        unknown: { keep: true },
      }),
    ],
  );
  await write("orders", "2026-09-20:LEGACY", {
    date: "2026-09-20",
    customer_code: "LEGACY",
    status: "ordered",
  });
  const migration = await readFile(
    new URL("../sql/02_dashboard.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);
  const after = (
    await db.query("select data,revision from cs_customers where id='LEGACY'")
  ).rows[0];
  assert.equal(after.data.tracking_since, "2026-09-20");
  assert.equal(after.revision, 9);
  assert.deepEqual(after.data.unknown, { keep: true });
  await db.exec(migration);
  assert.equal(
    (await db.query("select revision from cs_customers where id='LEGACY'"))
      .rows[0].revision,
    9,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from cs_change_log where kind='customers' and id='LEGACY'",
      )
    ).rows[0].n,
    1,
  );
});
