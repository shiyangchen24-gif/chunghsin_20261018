-- 唯讀盤點；先執行並下載結果，再由資料庫管理員審閱 migration。
select table_schema,table_name,column_name,data_type,is_nullable
from information_schema.columns
where table_schema in ('public','chunghsin_app')
order by table_schema,table_name,ordinal_position;
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public';
select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname='public';
select pubname,schemaname,tablename from pg_publication_tables;
select n.nspname,c.relname,c.reltuples::bigint as estimated_rows,c.relrowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' order by c.relname;
-- 精確舊表名稱（大小寫敏感）；不預設兩張表等價。
select to_regclass('public.zhongxin_store') as old_store,
       to_regclass('public."Chunghsin_store"') as current_store;
