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
