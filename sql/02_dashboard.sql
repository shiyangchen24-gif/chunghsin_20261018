-- 在 01_workspace.sql 之後執行。可重跑；不清除或重命名任何舊資料。
begin;
create index if not exists cs_orders_recent_called_idx on public.cs_orders(customer_code,service_day) where not deleted and data->>'status'='ordered';

-- 追蹤起日只建立一次。舊客戶依最早紀錄，無紀錄則自本次遷移日開始，避免新客戶被立即判為三日未叫貨。
create or replace function public.cs_set_customer_tracking() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare since_day text;
begin
 if tg_op='UPDATE' then since_day:=old.data->>'tracking_since';end if;
 since_day:=coalesce(since_day,new.data->>'tracking_since',(select min(service_day) from public.cs_orders where customer_code=new.id and not deleted),(now() at time zone 'Asia/Taipei')::date::text);
 perform since_day::date;
 if since_day!~'^\d{4}-\d{2}-\d{2}$' then raise exception '追蹤起日格式錯誤';end if;
 new.data:=jsonb_set(new.data,'{tracking_since}',to_jsonb(since_day));
 return new;
end $$;
drop trigger if exists cs_customer_tracking on public.cs_customers;
create trigger cs_customer_tracking before insert or update on public.cs_customers for each row execute function public.cs_set_customer_tracking();
-- 舊客戶補值同時產生新 revision 與小通知，已開啟的用戶端不會悄悄覆寫。
do $$ declare r record;begin
 perform pg_advisory_xact_lock(734108219);
 for r in update public.cs_customers set revision=revision+1,updated_at=now() where not deleted and data->>'tracking_since' is null returning id,revision loop
  insert into public.cs_change_log(kind,id,revision,deleted)values('customers',r.id,r.revision,false);
 end loop;
end $$;

-- 四類互斥：人工當日結果優先；三日含選定當日，採日曆日；不把衍生狀態寫回 orders。
create or replace function public.cs_classify_order(p_explicit text,p_day date,p_since date,p_last_ordered date) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_explicit in ('ordered','off') then p_explicit
 when p_since<=p_day-2 and (p_last_ordered is null or p_last_ordered<p_day-2) then 'overdue'
 else 'pending' end
$$;
create or replace function public.cs_order_summary(p_date text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 perform p_date::date;
 select coalesce(jsonb_object_agg(c.id,jsonb_build_object('last_ordered_before',(
  select max(o.service_day) from public.cs_orders o where not o.deleted and o.customer_code=c.id and o.data->>'status'='ordered' and o.service_day between ((p_date::date-2)::text) and ((p_date::date-1)::text)
 ))),'{}'::jsonb) into r from public.cs_customers c where not c.deleted and coalesce((c.data->>'active')::boolean,true);
 return r;
end $$;

-- 按需取得當月聚合結果；不傳原始歷史明細或報價 JSONB，沒有背景全表輪詢。
create or replace function public.cs_month_dashboard(p_month text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare first_day date;last_day date;r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 if p_month !~ '^\d{4}-\d{2}$' then raise exception '月份格式錯誤';end if;
 first_day:=(p_month||'-01')::date;
 last_day:=least((first_day+interval '1 month - 1 day')::date,(now() at time zone 'Asia/Taipei')::date);
 with customers as materialized (
  select id,data->>'name' name,coalesce(nullif(data->>'group',''),'未分類') group_name,(data->>'tracking_since')::date tracking_since
  from public.cs_customers where not deleted and coalesce((data->>'active')::boolean,true)
 ), days as (select d::date as service_date from generate_series(first_day::timestamp,last_day::timestamp,interval '1 day')d),
 classified as materialized (
  select c.id,d.service_date,public.cs_classify_order(o.data->>'status',d.service_date,c.tracking_since,
  (select max(p.service_day)::date from public.cs_orders p where not p.deleted and p.customer_code=c.id and p.data->>'status'='ordered' and p.service_day between ((d.service_date-2)::text) and d.service_date::text)) status
  from customers c cross join days d left join public.cs_orders o on o.customer_code=c.id and o.service_day=d.service_date::text and not o.deleted where c.tracking_since<=d.service_date
 ), daily as (
  select d.service_date date,count(t.id)filter(where status='ordered')ordered,count(t.id)filter(where status='pending')pending,count(t.id)filter(where status='off')off,count(t.id)filter(where status='overdue')overdue,count(t.id)total
  from days d left join classified t on t.service_date=d.service_date group by d.service_date order by d.service_date
 ), per_customer as (
  select c.id code,c.name,c.group_name as "group",c.tracking_since,count(t.id)filter(where status='ordered')ordered,count(t.id)filter(where status='pending')pending,count(t.id)filter(where status='off')off,count(t.id)filter(where status='overdue')overdue,count(t.id)total,coalesce(string_agg(case t.status when 'ordered' then 'O' when 'pending' then 'P' when 'off' then 'X' when 'overdue' then '!' end,'' order by t.service_date),'')daily_statuses
  from customers c left join classified t on t.id=c.id group by c.id,c.name,c.group_name,c.tracking_since order by c.id
 ), definitions as (
  select 'builtin:'||group_name id,group_name name,'客戶主檔' source,jsonb_agg(id order by id) customer_codes from customers group by group_name
  union all select g.id,g.data->>'name','自訂系列',g.data->'customer_codes' from public.cs_groups g where not g.deleted and jsonb_typeof(g.data->'customer_codes')='array'
 ), series as (
  select g.id,g.name,g.source,g.customer_codes,
  (select count(*) from customers c where g.customer_codes?c.id)total_customers,
  count(t.id)filter(where status='ordered')ordered,count(t.id)filter(where status='pending')pending,count(t.id)filter(where status='off')off,count(t.id)filter(where status='overdue')overdue,count(t.id)total
  from definitions g left join classified t on g.customer_codes?t.id group by g.id,g.name,g.source,g.customer_codes
 )
 select jsonb_build_object('month',p_month,'through',case when last_day>=first_day then last_day else null end,'total_customers',(select count(*) from customers),
 'counts',(select jsonb_build_object('ordered',count(*)filter(where status='ordered'),'pending',count(*)filter(where status='pending'),'off',count(*)filter(where status='off'),'overdue',count(*)filter(where status='overdue'),'total',count(*))from classified),
 'days',coalesce((select jsonb_agg(to_jsonb(d))from daily d),'[]'::jsonb),
 'customers',coalesce((select jsonb_agg(to_jsonb(c))from per_customer c),'[]'::jsonb),
 'series',coalesce((select jsonb_agg(to_jsonb(s)order by source,name,id)from series s),'[]'::jsonb))into r;
 return r;
end $$;
-- 舊的三日未叫 API 同步採四狀態規則，避免不同畫面互相矛盾。
create or replace function public.cs_warn3(p_date text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 select coalesce(jsonb_agg(c.id),'[]'::jsonb)into r from public.cs_customers c left join public.cs_orders o on o.customer_code=c.id and o.service_day=p_date and not o.deleted
 where not c.deleted and coalesce((c.data->>'active')::boolean,true) and public.cs_classify_order(o.data->>'status',p_date::date,(c.data->>'tracking_since')::date,(select max(p.service_day)::date from public.cs_orders p where not p.deleted and p.customer_code=c.id and p.data->>'status'='ordered' and p.service_day between ((p_date::date-2)::text)and p_date))='overdue';return r;
end $$;
revoke all on function public.cs_set_customer_tracking(),public.cs_classify_order(text,date,date,date) from public,anon,authenticated;
revoke all on function public.cs_order_summary(text),public.cs_month_dashboard(text),public.cs_warn3(text) from public,anon;
grant execute on function public.cs_order_summary(text),public.cs_month_dashboard(text),public.cs_warn3(text) to authenticated;
-- 單一客戶只回傳數字與最多 31 個狀態字元；其他裝置不重抓整月 Dashboard。
create or replace function public.cs_dashboard_customer(p_month text,p_code text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare first_day date;last_day date;r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 if p_month !~ '^\d{4}-\d{2}$' then raise exception '月份格式錯誤';end if;
 first_day:=(p_month||'-01')::date;last_day:=least((first_day+interval '1 month - 1 day')::date,(now() at time zone 'Asia/Taipei')::date);
 with customer as (
 select id,data->>'name' name,coalesce(nullif(data->>'group',''),'未分類') group_name,(data->>'tracking_since')::date tracking_since from public.cs_customers where id=p_code and not deleted and coalesce((data->>'active')::boolean,true)
 ), classified as (
 select c.id,d::date service_date,public.cs_classify_order(o.data->>'status',d::date,c.tracking_since,
 (select max(p.service_day)::date from public.cs_orders p where not p.deleted and p.customer_code=c.id and p.data->>'status'='ordered' and p.service_day between ((d::date-2)::text)and d::date::text))status
 from customer c cross join generate_series(greatest(first_day,c.tracking_since)::timestamp,last_day::timestamp,interval '1 day')d left join public.cs_orders o on o.customer_code=c.id and o.service_day=d::date::text and not o.deleted
 )
 select to_jsonb(t)into r from(
 select c.id code,c.name,c.group_name as "group",c.tracking_since,count(t.id)filter(where status='ordered')ordered,count(t.id)filter(where status='pending')pending,count(t.id)filter(where status='off')off,count(t.id)filter(where status='overdue')overdue,count(t.id)total,coalesce(string_agg(case t.status when 'ordered' then 'O' when 'pending' then 'P' when 'off' then 'X' when 'overdue' then '!' end,'' order by t.service_date),'')daily_statuses
 from customer c left join classified t on t.id=c.id group by c.id,c.name,c.group_name,c.tracking_since)t;
 return r;
end $$;
create or replace function public.cs_dashboard_customers(p_month text,p_codes text[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 if cardinality(p_codes)>500 then raise exception '最多 500 位客戶';end if;
 select coalesce(jsonb_agg(public.cs_dashboard_customer(p_month,code)),'[]'::jsonb)into r from (select distinct unnest(p_codes)code)t;
 return r;
end $$;
revoke all on function public.cs_dashboard_customer(text,text) from public,anon,authenticated;
revoke all on function public.cs_dashboard_customers(text,text[]) from public,anon;
grant execute on function public.cs_dashboard_customers(text,text[]) to authenticated;
create or replace function public.cs_order_summaries(p_date text,p_codes text[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 if cardinality(p_codes)>500 then raise exception '最多 500 位客戶';end if;
 perform p_date::date;
 select coalesce(jsonb_object_agg(c.id,jsonb_build_object('last_ordered_before',(
  select max(o.service_day) from public.cs_orders o where not o.deleted and o.customer_code=c.id and o.data->>'status'='ordered' and o.service_day between ((p_date::date-2)::text)and ((p_date::date-1)::text)
 ))),'{}'::jsonb)into r from public.cs_customers c where c.id=any(p_codes)and not c.deleted and coalesce((c.data->>'active')::boolean,true);return r;
end $$;
revoke all on function public.cs_order_summaries(text,text[]) from public,anon;
grant execute on function public.cs_order_summaries(text,text[]) to authenticated;
commit;
