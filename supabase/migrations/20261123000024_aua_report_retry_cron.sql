-- NHI-1 · 0024 (Supabase-specific: pg_cron, pg_net, vault). The daily report's retry (Opus card BOARD-FIX-1123, 4):
-- 00:40 UTC (08:40 台北), forty minutes after aua-report-daily. The report function runs again only when the day
-- has no "finished" run row yet ({"retry":1}); otherwise it answers skipped and sends nothing.
select cron.schedule('aua-report-retry', '40 0 * * *', $job$
  select net.http_post(
    url     := 'https://hjrnskmovwjtaifidldw.supabase.co/functions/v1/report',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-aua-export', (select decrypted_secret from vault.decrypted_secrets where name = 'aua_export_secret')),
    body    := '{"retry":1}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
