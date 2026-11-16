-- NHI-1 · export bucket private (全封閉, George 11/09 深夜; 4_ §3, §13). Supabase-specific.
-- The daily export job keeps writing here; nothing in it is reachable by URL any more. Replicas pull
-- only through the signed `replica` endpoint (closed until the export time format is decided).
update storage.buckets set public = false where id = 'export';
