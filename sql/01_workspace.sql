-- 新版工作台隔離 migration，保留所有既有資料表，不讀寫、不 rename 舊表。
-- 執行前先備份並跑 00_inspect.sql。cs_ 前綴為新版應用專用。
-- 單筆資料 JSONB，依業務種類拆表、依客戶拆品項；不保存全公司巨型快照。
begin;
create table if not exists public.cs_members (
 user_id uuid primary key references auth.users(id),
 role text not null check(role in ('admin','staff','viewer')),
 active boolean not null default true
);
alter table public.cs_members enable row level security;
create or replace function public.cs_role() returns text
language sql stable security definer set search_path=pg_catalog,public as $$
 select role from public.cs_members where user_id=auth.uid() and active
$$;
revoke all on function public.cs_role() from public,anon;
grant execute on function public.cs_role() to authenticated;
drop policy if exists cs_own_membership on public.cs_members;
create policy cs_own_membership on public.cs_members for select to authenticated using(user_id=auth.uid());
grant select on public.cs_members to authenticated;

do $migration$
declare k text;
begin
 foreach k in array array['customers','vehicles','assignments','aliases','orders','abnormal','handover','profiles','quote_items','mappings','master_items','notices','groups','manual'] loop
  execute format('create table if not exists public.%I (id text primary key, data jsonb not null check(jsonb_typeof(data)=''object''), revision bigint not null default 1 check(revision>0), deleted boolean not null default false, updated_at timestamptz not null default now(), customer_code text generated always as (data->>''customer_code'') stored, service_day text generated always as (data->>''date'') stored)', 'cs_'||k);
  execute format('alter table public.%I enable row level security','cs_'||k);
  execute format('revoke all on public.%I from anon,authenticated','cs_'||k);
  execute format('create index if not exists %I on public.%I (service_day,id) where not deleted','cs_'||k||'_date_idx','cs_'||k);
  execute format('create index if not exists %I on public.%I (customer_code,id) where not deleted','cs_'||k||'_customer_idx','cs_'||k);
 end loop;
end $migration$;
-- 穩定客戶代號使用 customers.id；同名不自動合併。
create unique index if not exists cs_vehicle_no_unique on public.cs_vehicles ((data->>'car_no')) where not deleted;
create unique index if not exists cs_customer_code_unique on public.cs_customers ((data->>'code')) where not deleted;
create unique index if not exists cs_order_day_customer_unique on public.cs_orders (service_day,customer_code) where not deleted;
create table if not exists public.cs_change_log(
 seq bigint generated always as identity primary key,
 kind text not null,id text not null,revision bigint not null,deleted boolean not null,
 day text,created_at timestamptz not null default now()
);
alter table public.cs_change_log enable row level security;
drop policy if exists cs_member_events on public.cs_change_log;
create policy cs_member_events on public.cs_change_log for select to authenticated using(public.cs_role() is not null);
grant select on public.cs_change_log to authenticated;
revoke all on public.cs_change_log from anon;
create table if not exists public.cs_requests(request_id uuid primary key,actor uuid not null,result jsonb not null,created_at timestamptz not null default now());
alter table public.cs_requests enable row level security;
revoke all on public.cs_requests from anon,authenticated;

create or replace function public.cs_valid_kind(p_kind text) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select p_kind=any(array['customers','vehicles','assignments','aliases','orders','abnormal','handover','profiles','quote_items','mappings','master_items','notices','groups','manual'])
$$;
create or replace function public.cs_envelope(p_kind text,p_row jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('kind',p_kind,'id',p_row->'id','data',p_row->'data','revision',p_row->'revision','deleted',p_row->'deleted')
$$;
create table if not exists public.cs_order_events(
 id bigint generated always as identity primary key,
 customer_code text not null,service_date text not null,
 old_status text,new_status text,actor uuid,commit_seq bigint not null,
 request_id uuid not null,created_at timestamptz not null default now()
);
alter table public.cs_order_events enable row level security;
revoke all on public.cs_order_events from anon,authenticated;
create index if not exists cs_order_events_day_idx on public.cs_order_events(service_date,commit_seq);
create or replace function public.cs_write(p_kind text,p_id text,p_data jsonb,p_expected bigint,p_request uuid,p_delete boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare oldrow jsonb;result jsonb;last_result jsonb;member_role text;customer text;event_seq bigint;
begin
 member_role:=public.cs_role();
 if member_role is null or member_role='viewer' then raise exception '沒有寫入權限';end if;
 if not public.cs_valid_kind(p_kind) or length(p_id) not between 1 and 300 or p_expected<0 or jsonb_typeof(p_data)<>'object' then raise exception '資料格式錯誤';end if;
 if octet_length(p_data::text)>65536 then raise exception '單筆資料超過 64 KB，請拆分品項';end if;
 if p_delete and member_role<>'admin' and p_kind not in ('quote_items','mappings') then raise exception '僅管理員可刪除資料';end if;
 -- 鎖涵蓋所有寫入至交易提交；取得序號的順序等於提交可見順序，避免 sequence 提早配號漏件。
 perform pg_advisory_xact_lock(734108219);
 select r.result into last_result from public.cs_requests r where request_id=p_request and actor=auth.uid();
 if last_result is not null then return last_result;end if;
 if exists(select 1 from public.cs_requests where request_id=p_request)then raise exception 'request_id 已使用';end if;
 execute format('select to_jsonb(t) from public.%I t where id=$1 for update','cs_'||p_kind) into oldrow using p_id;
 if coalesce((oldrow->>'revision')::bigint,0)<>p_expected then raise exception '資料已在其他裝置更新，請重新開啟後再儲存';end if;
 if p_kind='customers' and (p_data->>'code' is distinct from p_id or coalesce(trim(p_data->>'name'),'')='')then raise exception '客戶代號或名稱錯誤';end if;
 customer:=p_data->>'customer_code';
 if p_kind in ('orders','profiles','quote_items','mappings','assignments','aliases') and (customer is null or not exists(select 1 from public.cs_customers where id=customer and not deleted))then raise exception '客戶代號不存在';end if;
 if p_kind='orders' and (p_data->>'status' not in ('pending','ordered','off') or p_data->>'status' is null or p_id is distinct from (p_data->>'date')||':'||customer)then raise exception '叫貨狀態或唯一鍵錯誤';end if;
 if p_kind in ('orders','abnormal','handover') then
  if (p_data->>'date') is null or (p_data->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '日期格式錯誤';end if;
  perform (p_data->>'date')::date;
 end if;
 execute format('insert into public.%I(id,data,revision,deleted) values($1,$2,$3,$4) on conflict(id) do update set data=excluded.data,revision=excluded.revision,deleted=excluded.deleted,updated_at=now() returning to_jsonb(%I.*)','cs_'||p_kind,'cs_'||p_kind) into result using p_id,(p_data-'id'-'revision'),p_expected+1,p_delete;
 result:=public.cs_envelope(p_kind,result);
 insert into public.cs_change_log(kind,id,revision,deleted,day) values(p_kind,p_id,p_expected+1,p_delete,p_data->>'date') returning seq into event_seq;
 if p_kind='orders' then insert into public.cs_order_events(customer_code,service_date,old_status,new_status,actor,commit_seq,request_id) values(customer,p_data->>'date',oldrow->'data'->>'status',p_data->>'status',auth.uid(),event_seq,p_request);end if;
 insert into public.cs_requests(request_id,actor,result) values(p_request,auth.uid(),result);
 return result;
end $$;
create or replace function public.cs_get(p_kind text,p_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 if not public.cs_valid_kind(p_kind)then raise exception '未知資料種類';end if;
 execute format('select to_jsonb(t) from public.%I t where id=$1 and not deleted','cs_'||p_kind) into r using p_id;
 return case when r is null then null else public.cs_envelope(p_kind,r) end;
end $$;
create or replace function public.cs_page(p_kind text,p_day text default null,p_before text default null,p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;cap int;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 if not public.cs_valid_kind(p_kind)then raise exception '未知資料種類';end if;
 cap:=case when p_kind='orders' and p_day is not null then 500 else 50 end;
 execute format('select coalesce(jsonb_agg(public.cs_envelope($1,to_jsonb(t))),''[]''::jsonb) from (select id,data,revision,deleted from public.%I where not deleted and ($2 is null or service_day=$2) and ($3 is null or id<$3) order by id desc limit $4)t','cs_'||p_kind) into r using p_kind,p_day,p_before,least(greatest(p_limit,1),cap);
 return r;
end $$;
create or replace function public.cs_details(p_kind text,p_customer text,p_before text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 if p_kind not in ('quote_items','mappings','assignments','aliases') then raise exception '不允許的明細種類';end if;
 execute format('select coalesce(jsonb_agg(public.cs_envelope($1,to_jsonb(t))),''[]''::jsonb) from (select id,data,revision,deleted from public.%I where not deleted and customer_code=$2 and ($3 is null or id<$3) order by id desc limit 50)t','cs_'||p_kind) into r using p_kind,p_customer,p_before;
 return r;
end $$;
create or replace function public.cs_history(p_date text,p_before text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 select coalesce(jsonb_agg(public.cs_envelope('orders',to_jsonb(t))),'[]'::jsonb) into r from
 (select id,data,revision,deleted from public.cs_orders where not deleted and service_day between ((p_date::date-29)::text) and p_date and (p_before is null or id<p_before) order by id desc limit 50)t;
 return r;
end $$;
create or replace function public.cs_watermark() returns bigint
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin if public.cs_role() is null then raise exception '請先登入內部成員';end if;return coalesce((select max(seq) from public.cs_change_log),0);end $$;
create or replace function public.cs_changes(p_after bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into r from (select seq,kind,id,revision,deleted,day from public.cs_change_log where seq>p_after order by seq limit 100)t;return r;
end $$;
-- 只授權公開入口；內部 helper 不開放 RPC。
revoke all on function public.cs_valid_kind(text),public.cs_envelope(text,jsonb) from public,anon,authenticated;
revoke all on function public.cs_write(text,text,jsonb,bigint,uuid,boolean),public.cs_get(text,text),public.cs_page(text,text,text,int),public.cs_details(text,text,text),public.cs_history(text,text),public.cs_watermark(),public.cs_changes(bigint) from public,anon;
grant execute on function public.cs_write(text,text,jsonb,bigint,uuid,boolean),public.cs_get(text,text),public.cs_page(text,text,text,int),public.cs_details(text,text,text),public.cs_history(text,text),public.cs_watermark(),public.cs_changes(bigint) to authenticated;
-- 只發布小通知；任何含大型 JSONB 的業務表都不加入 publication。
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='cs_change_log') then
 alter publication supabase_realtime add table public.cs_change_log;
 end if;
end $$;
-- Dashboard Auth 建立帳號後，由管理員以 SQL 明確授權（替換 UUID，勿把 service key 放前端）：
-- insert into public.cs_members(user_id,role) values ('使用者UUID','admin')
-- on conflict(user_id) do update set role=excluded.role,active=true;

-- 批次以同一交易執行；任何版本衝突會全部回滾。
create or replace function public.cs_batch(p_operations jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare op jsonb;results jsonb:='[]'::jsonb;
begin
 if public.cs_role() not in ('admin','staff') or public.cs_role() is null then raise exception '沒有寫入權限';end if;
 if jsonb_typeof(p_operations)<>'array' or jsonb_array_length(p_operations)>5000 then raise exception '批次上限為 5000 筆';end if;
 perform pg_advisory_xact_lock(734108219);
 for op in select value from jsonb_array_elements(p_operations) loop
  results:=results||jsonb_build_array(public.cs_write(op->>'kind',op->>'id',op->'data',(op->>'expected')::bigint,(op->>'request')::uuid,coalesce((op->>'deleted')::boolean,false)));
 end loop;
 return results;
end $$;
revoke all on function public.cs_batch(jsonb) from public,anon;
grant execute on function public.cs_batch(jsonb) to authenticated;
create or replace function public.cs_warn3(p_date text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 select coalesce(jsonb_agg(c.id),'[]'::jsonb) into r from public.cs_customers c
 where not c.deleted and coalesce((c.data->>'active')::boolean,true)
 and not exists(select 1 from public.cs_orders o where not o.deleted and o.customer_code=c.id and o.service_day between ((p_date::date-2)::text) and p_date and o.data->>'status'='ordered');
 return r;
end $$;
revoke all on function public.cs_warn3(text) from public,anon;
grant execute on function public.cs_warn3(text) to authenticated;

-- 真正的關聯約束：新客戶／品項按代號關聯，不按名稱合併。
do $$
declare k text;
begin
 foreach k in array array['orders','profiles','quote_items','mappings','assignments','aliases'] loop
  if not exists(select 1 from pg_constraint where conname='cs_'||k||'_customer_fk' and conrelid=('public.cs_'||k)::regclass) then
   execute format('alter table public.%I add constraint %I foreign key(customer_code) references public.cs_customers(id)','cs_'||k,'cs_'||k||'_customer_fk');
  end if;
 end loop;
end $$;
alter table public.cs_assignments add column if not exists vehicle_id text generated always as(data->>'vehicle_id') stored;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='cs_assignments_vehicle_fk' and conrelid='public.cs_assignments'::regclass) then
  alter table public.cs_assignments add constraint cs_assignments_vehicle_fk foreign key(vehicle_id) references public.cs_vehicles(id);
 end if;
end $$;
create or replace function public.cs_lookup_counts() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 if public.cs_role() is null then raise exception '請先登入內部成員';end if;
 select coalesce(jsonb_object_agg(t.id,t.n),'{}'::jsonb) into r from (
  select c.id,count(m.id) as n from public.cs_customers c left join public.cs_mappings m on m.customer_code=c.id and not m.deleted where not c.deleted group by c.id
 ) t;
 return r;
end $$;
revoke all on function public.cs_lookup_counts() from public,anon;
grant execute on function public.cs_lookup_counts() to authenticated;
commit;
