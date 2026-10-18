import test from "node:test";
import assert from "node:assert/strict";
// 模組載入時 store 只建立空白本機，不接觸任何遠端。
global.localStorage = { getItem: () => null };
global.window = { addEventListener() {} };
global.document = { addEventListener() {} };
const { numeric, convert, guess } = await import("../js/excel.js");
const { validateConfig } = await import("../js/store.js");
test("numeric 清除千分位、貨幣及括號負數；無效值不得靜默歸零", () => {
  assert.equal(numeric("$1,250"), 1250);
  assert.equal(numeric("(1,250)"), -1250);
  assert.equal(numeric(""), 0);
  assert.throws(() => numeric("待確認"));
});
test("並排多組貨號與單價展開、空白單價與不報價原因", () => {
  const result = convert(
    [
      ["A", "蘋果", "$1,200", "不報", "B", "香蕉", "", "時價"],
      ["C", "檸檬", "10", "", "", "", "", ""],
    ],
    [
      "貨號",
      "品名",
      "單價",
      "不報價原因",
      "貨號",
      "品名",
      "單價",
      "不報價原因",
    ],
    0,
    "有貨號",
  );
  assert.equal(result.length, 3);
  assert.equal(result[0].單價, 1200);
  assert.equal(result[0].不報價原因, "");
  assert.equal(result[1].單價, 0);
  assert.equal(result[1].不報價原因, "時價");
});
test("隱藏列跳過；新品與無貨號對照使用官方單位", () => {
  const hidden = ["隱藏", "1"];
  hidden.hidden = true;
  const result = convert(
    [["蘋果", "20"], ["香蕉", "35"], hidden],
    ["品名", "單價"],
    0,
    "無貨號",
    ["蘋果"],
    { 蘋果: "A" },
    [{ item_code: "A", unit: "kg" }],
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].單位, "kg");
  assert.equal(result[1].new, true);
  assert.equal(result[1].unmatched, true);
});
test("空白表頭在識別欄後推測單價", () =>
  assert.deepEqual(guess(["品名", "", "品名", ""]), [
    "品名",
    "單價",
    "品名",
    "單價",
  ]));
test("阻擋 secret/service role 及 REST 路徑", () => {
  assert.throws(() =>
    validateConfig("https://test.supabase.co/rest/v1", "sb_publishable_x"),
  );
  assert.throws(() =>
    validateConfig("https://test.supabase.co", "sb_secret_foo"),
  );
  const jwt =
    "eyJ." +
    Buffer.from(JSON.stringify({ role: "service_role" })).toString(
      "base64url",
    ) +
    ".sig";
  assert.throws(() => validateConfig("https://test.supabase.co", jwt));
  assert.equal(
    validateConfig("https://test.supabase.co/", "sb_publishable_example").url,
    "https://test.supabase.co",
  );
});

test("不報價原因不得被猜成單價", () =>
  assert.deepEqual(guess(["貨號", "單價", "不報價原因", "變價原因"]), [
    "貨號",
    "單價",
    "不報價原因",
    "變價原因",
  ]));
