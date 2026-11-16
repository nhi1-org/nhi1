-- NHI-1 · schedules for the wind tunnel and the daily report. Supabase-specific (pg_cron, pg_net, vault).
-- Same vault-held job secret as the export job; nothing here leaves the database.
--   wind   23:30 UTC (07:30 台北): interface replay + canary; emergencies go out at once
--   report 00:00 UTC (08:00 台北): the daily report, every day

select cron.schedule('aua-wind-daily', '30 23 * * *', $job$
  select net.http_post(
    url     := 'https://hjrnskmovwjtaifidldw.supabase.co/functions/v1/wind',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-aua-export', (select decrypted_secret from vault.decrypted_secrets where name = 'aua_export_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000)
$job$);

select cron.schedule('aua-report-daily', '0 0 * * *', $job$
  select net.http_post(
    url     := 'https://hjrnskmovwjtaifidldw.supabase.co/functions/v1/report',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-aua-export', (select decrypted_secret from vault.decrypted_secrets where name = 'aua_export_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
