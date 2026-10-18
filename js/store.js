import { normalizeTracking } from "./orders.js?v=1.1.0";
export const VERSION = "1.1.0";
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const uid = () => crypto.randomUUID();
export const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const kinds = [
  "customers",
  "vehicles",
  "assignments",
  "aliases",
  "orders",
  "abnormal",
  "handover",
  "profiles",
  "quote_items",
  "mappings",
  "master_items",
  "notices",
  "groups",
  "manual",
];
const KEY = "chunghsin.workspace.v1",
  CONFIG = "chunghsin.connection.v1";
export const readConfig = () =>
  JSON.parse(localStorage.getItem(CONFIG) || "{}");
export function validateConfig(url, key) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    !u.hostname.endsWith(".supabase.co") ||
    !["", "/"].includes(u.pathname)
  )
    throw Error("請填入 Supabase 專案基本 HTTPS 網址，不含 /rest/v1。");
  if (key.startsWith("sb_secret_")) throw Error("不可使用高權限 secret key。");
  if (key.startsWith("eyJ")) {
    let p;
    try {
      p = JSON.parse(
        atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
    } catch {
      throw Error("金鑰格式不正確。");
    }
    if (p.role !== "anon") throw Error("前端只接受 anon / publishable key。");
  } else if (!key.startsWith("sb_publishable_"))
    throw Error("請使用 anon 或 publishable key。");
  return { url: u.origin, key };
}
export function saveConfig(url, key) {
  localStorage.setItem(CONFIG, JSON.stringify(validateConfig(url, key)));
}
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.loaded) return resolve();
    const s = existing || document.createElement("script");
    s.src = src;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => {
      s.remove();
      reject(Error("外部工具載入失敗，請檢查網路後重試。"));
    };
    if (!existing) document.body.append(s);
  });
}
export class Store extends EventTarget {
  constructor() {
    super();
    this.rows = normalizeTracking(
      JSON.parse(localStorage.getItem(KEY) || "[]"),
      today(),
    );
    if (this.rows.length) this.persist();
    this.analyticsRevision = 0;
    this.analyticsFullRefresh = true;
    this.analyticsCustomers = new Map();
    this.sb = null;
    this.cloud = false;
    this.cursor = 0;
    this.channel = null;
    this.running = false;
    this.metrics = { apiBytes: 0, requests: 0, events: 0 };
    this.status = "本機模式";
    this.role = "local";
    this.loaded = new Set();
    this.activeDay = today();
    this.onStorage = (e) => {
      if (e.key === KEY && !this.cloud) {
        this.rows = normalizeTracking(JSON.parse(e.newValue || "[]"), today());
        this.analyticsRevision++;
        this.emit();
      }
    };
    window.addEventListener("storage", this.onStorage);
    window.addEventListener("online", () => this.resume());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
      else this.resume();
    });
  }
  emit() {
    this.dispatchEvent(new Event("change"));
  }
  list(kind, predicate = () => true) {
    return this.rows
      .filter((r) => r.kind === kind && !r.deleted && predicate(r.data))
      .map((r) => ({ ...r.data, id: r.id, revision: r.revision }));
  }
  get(kind, id) {
    return this.list(kind).find((r) => r.id === id);
  }
  touch(kind, id) {
    if (!["orders", "customers", "groups"].includes(kind)) return;
    this.analyticsRevision++;
    if (kind === "orders" && id)
      this.analyticsCustomers.set(id.slice(11), this.analyticsRevision);
    else this.analyticsFullRefresh = true;
  }
  merge(r) {
    const old = this.rows.find((x) => x.kind === r.kind && x.id === r.id);
    if (old && Number(old.revision) > Number(r.revision)) return;
    this.rows = this.rows.filter((x) => !(x.kind === r.kind && x.id === r.id));
    this.rows.push(r);
    this.touch(r.kind, r.id);
  }
  persist() {
    localStorage.setItem(KEY, JSON.stringify(this.rows));
  }
  async rpc(name, args = {}) {
    this.metrics.requests++;
    const { data, error } = await this.sb.rpc("cs_" + name, args);
    if (error) throw Error(error.message);
    this.metrics.apiBytes += new TextEncoder().encode(
      JSON.stringify(data),
    ).length;
    return data;
  }
  async mutate(
    kind,
    id,
    data,
    { revision = 0, remove = false, requestId = uid() } = {},
  ) {
    if (!kinds.includes(kind)) throw Error("未知資料類型");
    const original = this.rows.find((r) => r.kind === kind && r.id === id);
    if ((original?.revision || 0) !== revision)
      throw Error("資料已在其他視窗更新，請重新開啟後再試。");
    if (kind === "customers")
      data = {
        ...data,
        tracking_since:
          original?.data.tracking_since || data.tracking_since || today(),
      };
    this.touch(kind, id);
    const candidate = {
      kind,
      id,
      data,
      revision: revision + 1,
      deleted: remove,
    };
    this.rows = this.rows.filter((r) => !(r.kind === kind && r.id === id));
    this.rows.push(candidate);
    this.status = this.cloud ? "儲存中…" : "本機已儲存";
    try {
      this.emit();
      if (this.cloud) {
        const result = await this.rpc("write", {
          p_kind: kind,
          p_id: id,
          p_data: data,
          p_expected: revision,
          p_request: requestId,
          p_delete: remove,
        });
        Object.assign(candidate, result);
      } else this.persist();
      this.touch(kind, id);
      this.status = this.cloud ? "已同步" : "本機已儲存";
      this.emit();
      return candidate;
    } catch (e) {
      if (this.rows.includes(candidate)) {
        this.rows = this.rows.filter((r) => r !== candidate);
        if (original) this.rows.push(original);
      }
      this.touch(kind, id);
      this.status = "儲存失敗 · 未同步";
      this.emit();
      throw e;
    }
  }
  async batch(operations) {
    if (!operations.length) return;
    const snapshot = structuredClone(this.rows);
    operations = operations.map((o) =>
      o.kind === "customers"
        ? {
            ...o,
            data: {
              ...o.data,
              tracking_since:
                this.get("customers", o.id)?.tracking_since ||
                o.data.tracking_since ||
                today(),
            },
          }
        : o,
    );
    try {
      if (this.cloud) {
        const rs = await this.rpc("batch", {
          p_operations: operations.map((o) => ({
            kind: o.kind,
            id: o.id,
            data: o.data,
            expected: o.revision || 0,
            request: o.requestId || uid(),
            deleted: !!o.remove,
          })),
        });
        for (const r of rs) {
          this.rows = this.rows.filter(
            (x) => !(x.kind === r.kind && x.id === r.id),
          );
          this.rows.push(r);
        }
      } else {
        for (const o of operations) {
          const old = this.rows.find((r) => r.kind === o.kind && r.id === o.id);
          if ((old?.revision || 0) !== (o.revision || 0))
            throw Error("資料版本已變更，整批儲存已取消。");
          this.rows = this.rows.filter(
            (r) => !(r.kind === o.kind && r.id === o.id),
          );
          this.rows.push({
            kind: o.kind,
            id: o.id,
            data: o.data,
            revision: (o.revision || 0) + 1,
            deleted: !!o.remove,
          });
        }
        this.persist();
      }
      for (const op of operations) this.touch(op.kind, op.id);
      this.status = this.cloud ? "已同步" : "本機已儲存";
      this.emit();
    } catch (err) {
      this.rows = snapshot;
      this.status = "整批儲存失敗 · 未變更";
      this.emit();
      throw err;
    }
  }
  async initCloud() {
    const c = readConfig();
    if (!c.url) return false;
    await loadScript(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.8/dist/umd/supabase.js",
    );
    this.sb = window.supabase.createClient(c.url, c.key);
    const {
      data: { session },
    } = await this.sb.auth.getSession();
    if (session) await this.activate();
    this.sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        this.pause();
        this.cloud = false;
        this.rows = JSON.parse(localStorage.getItem(KEY) || "[]");
        this.emit();
      }
    });
    return true;
  }
  async login(email, password) {
    if (!this.sb) throw Error("請先儲存 Supabase 連線設定。");
    const { error } = await this.sb.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw Error(error.message);
    await this.activate();
  }
  async activate() {
    this.role = await this.rpc("role");
    if (!this.role) throw Error("帳號尚未加入內部成員名單。");
    this.pause();
    this.rows = [];
    this.loaded.clear();
    this.cloud = true;
    this.cursor = Number(await this.rpc("watermark"));
    this.status = "連線中";
    await this.resume();
    this.emit();
  }
  async load(kind, { day = null, before = null, limit = 50 } = {}) {
    if (!this.cloud) return [];
    const rows = await this.rpc("page", {
      p_kind: kind,
      p_day: day,
      p_before: before,
      p_limit: limit,
    });
    for (const r of rows) this.merge(r);
    this.loaded.add(kind);
    this.emit();
    return rows;
  }
  async loadAllSmall(kind) {
    let before = null,
      rows;
    do {
      rows = await this.load(kind, { before, limit: 50 });
      before = rows.at(-1)?.id;
    } while (rows.length === 50);
  }
  async changes() {
    if (!this.cloud || this.syncing) return;
    this.syncing = true;
    try {
      let events;
      do {
        events = await this.rpc("changes", { p_after: this.cursor });
        for (const e of events) {
          this.touch(e.kind, e.id);
          if (e.kind === "mappings") this.mappingDirty = true;
          const old = this.rows.find((x) => x.kind === e.kind && x.id === e.id);
          if (e.deleted)
            this.merge({
              kind: e.kind,
              id: e.id,
              data: old?.data || {},
              revision: e.revision,
              deleted: true,
            });
          else if (
            old ||
            [
              "customers",
              "vehicles",
              "assignments",
              "aliases",
              "profiles",
              "notices",
              "groups",
            ].includes(e.kind) ||
            e.day === this.activeDay
          ) {
            const r = await this.rpc("get", { p_kind: e.kind, p_id: e.id });
            if (r) this.merge(r);
          }
          this.cursor = Number(e.seq);
          this.metrics.events++;
        }
      } while (events.length === 100);
      if (this.loaded.has("profiles") && this.mappingDirty) {
        this.mappingCounts = await this.rpc("lookup_counts");
        this.mappingDirty = false;
      }
      this.retry = 0;
      this.status = "已同步";
      this.emit();
    } catch (e) {
      this.status = "同步中斷 · 將自動重試";
      this.emit();
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(
        () => this.changes(),
        Math.min(
          60000,
          1000 * 2 ** Math.min((this.retry = (this.retry || 0) + 1), 6),
        ) +
          Math.random() * 1000,
      );
    } finally {
      this.syncing = false;
    }
  }
  async resume() {
    if (!this.cloud || document.hidden || !navigator.onLine) return;
    this.pause();
    this.channel = this.sb
      .channel("cs-small-events")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "cs_change_log" },
        () => this.changes(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") this.changes();
      });
    await this.changes();
    this.timer = setInterval(async () => {
      try {
        if (Number(await this.rpc("watermark")) > this.cursor)
          await this.changes();
      } catch {
        this.status = "離線 · 未同步";
        this.emit();
      }
    }, 30000);
  }
  pause() {
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    if (this.channel && this.sb) this.sb.removeChannel(this.channel);
    this.channel = null;
  }
  demo() {
    if (this.cloud || this.rows.some((r) => !r.deleted))
      throw Error("範例只能載入空白本機工作空間。");
    const names = [
      "欣葉台菜・信義店",
      "饗食天堂・京站店",
      "晶華酒店",
      "鼎泰豐・信義店",
      "漢來海港・天母店",
      "王品牛排・中山店",
      "君悅酒店",
      "瓦城・南港店",
      "誠品行旅",
      "寒舍艾美酒店",
      "青青食尚花園",
      "十二廚",
    ];
    const groups = ["餐飲客戶", "飯店客戶", "團膳客戶"];
    for (let i = 0; i < names.length; i++) {
      const id = "DEMO" + String(i + 1).padStart(3, "0");
      this.rows.push({
        kind: "customers",
        id,
        revision: 1,
        data: {
          code: id,
          name: names[i],
          group: groups[i % 3],
          car_no: ["1號車", "2號車", "3號車"][i % 3],
          fixed: i % 4 === 0,
          notes: "示範資料，非實際客戶",
          active: true,
        },
      });
      if (i < 5)
        this.rows.push({
          kind: "orders",
          id: `${today()}:${id}`,
          revision: 1,
          data: {
            customer_code: id,
            date: today(),
            status: "ordered",
            fixed: i % 4 === 0,
            at: new Date().toISOString(),
          },
        });
      this.rows.push({
        kind: "profiles",
        id,
        revision: 1,
        data: {
          customer_code: id,
          mode: i % 2 ? "無貨號" : "有貨號",
          cycle: 7,
          unit: i % 2 ? "kg" : "",
          notes: "",
          mapping: null,
          item_count: 0,
        },
      });
    }
    this.rows.push({
      kind: "notices",
      id: uid(),
      revision: 1,
      data: {
        title: "歡迎使用忠欣工作台",
        text: "這是示範留言。正式使用前，請先至系統設定連接共用資料庫。",
        at: new Date().toISOString(),
      },
    });
    this.rows = normalizeTracking(this.rows, today());
    this.analyticsRevision++;
    this.persist();
    this.emit();
  }
}
export const store = new Store();
