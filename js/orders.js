// 純日期與統計函式；所有日期皆為台北營業日的 YYYY-MM-DD。
export const ORDER_LABELS = {
  ordered: "已叫貨",
  pending: "未叫貨",
  off: "今日不叫貨",
  overdue: "三日未叫貨",
};
export function shiftDay(day, delta) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
export function trackingSince(customer, records, fallback) {
  return (
    customer.tracking_since ||
    records
      .filter((r) => r.customer_code === customer.code)
      .map((r) => r.date)
      .filter(Boolean)
      .sort()[0] ||
    fallback
  );
}
export function orderStatus(explicit, day, since, lastOrdered) {
  if (explicit === "ordered" || explicit === "off") return explicit;
  return since &&
    since <= shiftDay(day, -2) &&
    (!lastOrdered || lastOrdered < shiftDay(day, -2))
    ? "overdue"
    : "pending";
}
export function classify(customer, records, day, fallback) {
  const own = records.filter(
    (r) => r.customer_code === customer.code && r.date <= day,
  );
  const explicit = own.find((r) => r.date === day)?.status;
  const last = own
    .filter((r) => r.status === "ordered")
    .map((r) => r.date)
    .sort()
    .at(-1);
  return orderStatus(
    explicit,
    day,
    trackingSince(customer, records, fallback),
    last,
  );
}
export function dailyStatuses(
  customers,
  records,
  day,
  referenceDay,
  cloudSummary,
) {
  const explicit = new Map(),
    last = new Map(),
    first = new Map();
  for (const r of records) {
    if (!first.has(r.customer_code) || r.date < first.get(r.customer_code))
      first.set(r.customer_code, r.date);
    if (r.date === day) explicit.set(r.customer_code, r.status);
    if (
      r.status === "ordered" &&
      r.date <= day &&
      (!last.has(r.customer_code) || r.date > last.get(r.customer_code))
    )
      last.set(r.customer_code, r.date);
  }
  return new Map(
    customers.map((c) => {
      const since = c.tracking_since || first.get(c.code) || referenceDay;
      const previous =
        cloudSummary === undefined
          ? last.get(c.code)
          : cloudSummary === null
            ? day
            : cloudSummary[c.code]?.last_ordered_before;
      return [c.code, orderStatus(explicit.get(c.code), day, since, previous)];
    }),
  );
}
export function normalizeTracking(rows, fallback) {
  const records = rows
    .filter((r) => r.kind === "orders" && !r.deleted)
    .map((r) => r.data);
  return rows.map((r) =>
    r.kind === "customers" && !r.data.tracking_since
      ? {
          ...r,
          data: {
            ...r.data,
            tracking_since: trackingSince(r.data, records, fallback),
          },
        }
      : r,
  );
}
export function seriesDefinitions(customers, customGroups) {
  const builtin = [...new Set(customers.map((c) => c.group || "未分類"))]
    .sort()
    .map((name) => ({
      id: "builtin:" + name,
      name,
      source: "客戶主檔",
      customer_codes: customers
        .filter((c) => (c.group || "未分類") === name)
        .map((c) => c.code),
    }));
  return [
    ...builtin,
    ...customGroups
      .filter((g) => Array.isArray(g.customer_codes))
      .map((g) => ({ ...g, source: "自訂系列" })),
  ];
}
const zero = () => ({ ordered: 0, pending: 0, off: 0, overdue: 0, total: 0 });
export function monthSummary(
  customers,
  records,
  customGroups,
  month,
  referenceDay,
) {
  const first = month + "-01",
    end = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
    )
      .toISOString()
      .slice(0, 10);
  const through = end < referenceDay ? end : referenceDay;
  const cs = customers.filter((c) => c.active !== false),
    days = [],
    counts = new Map(cs.map((c) => [c.code, zero()])),
    codes = new Map(cs.map((c) => [c.code, []]));
  const index = new Map(
    records.map((r) => [r.date + ":" + r.customer_code, r.status]),
  );
  const definitions = seriesDefinitions(cs, customGroups);
  const series = definitions.map((g) => ({
    ...g,
    total_customers: g.customer_codes.filter((code) => counts.has(code)).length,
    ...zero(),
  }));
  for (let day = first; day <= through; day = shiftDay(day, 1)) {
    const daily = { date: day, ...zero() };
    for (const c of cs) {
      const since = trackingSince(c, records, referenceDay);
      if (since > day) continue;
      let last = null;
      for (let n = 0; n < 3; n++) {
        const d = shiftDay(day, -n);
        if (index.get(d + ":" + c.code) === "ordered") {
          last = d;
          break;
        }
      }
      const s = orderStatus(index.get(day + ":" + c.code), day, since, last);
      daily[s]++;
      daily.total++;
      counts.get(c.code)[s]++;
      counts.get(c.code).total++;
      codes
        .get(c.code)
        .push({ ordered: "O", pending: "P", off: "X", overdue: "!" }[s]);
      for (const group of series)
        if (group.customer_codes.includes(c.code)) {
          group[s]++;
          group.total++;
        }
    }
    days.push(daily);
  }
  const total = days.reduce((a, d) => {
    for (const k of Object.keys(a)) a[k] += d[k];
    return a;
  }, zero());
  return {
    month,
    through: through >= first ? through : null,
    total_customers: cs.length,
    counts: total,
    days,
    customers: cs.map((c) => ({
      code: c.code,
      name: c.name,
      group: c.group || "未分類",
      tracking_since: trackingSince(c, records, referenceDay),
      ...counts.get(c.code),
      daily_statuses: codes.get(c.code).join(""),
    })),
    series,
  };
}

// 只更新變更客戶；每日與系列統計在本機扣舊加新，不重新傳送整月資料。
export function patchMonthSummary(summary, replacements) {
  const data = structuredClone(summary),
    keys = ["ordered", "pending", "off", "overdue", "total"],
    decode = { O: "ordered", P: "pending", X: "off", "!": "overdue" };
  const byDay = new Map(data.days.map((d) => [d.date, d]));
  for (const next of replacements) {
    const index = data.customers.findIndex((c) => c.code === next.code);
    if (index < 0) throw Error("客戶集合已變更，需重新載入統計。");
    const old = data.customers[index];
    for (const [c, delta] of [
      [old, -1],
      [next, 1],
    ]) {
      let day =
        c.tracking_since > data.month + "-01"
          ? c.tracking_since
          : data.month + "-01";
      for (const code of c.daily_statuses) {
        const row = byDay.get(day);
        if (row) {
          row[decode[code]] += delta;
          row.total += delta;
        }
        day = shiftDay(day, 1);
      }
    }
    for (const key of keys) data.counts[key] += next[key] - old[key];
    for (const group of data.series)
      if (group.customer_codes.includes(next.code))
        for (const key of keys) group[key] += next[key] - old[key];
    data.customers[index] = next;
  }
  return data;
}
