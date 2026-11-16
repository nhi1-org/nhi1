-- NHI-1 · daily full export + housekeeping. Supabase-specific (storage, vault, pg_cron, pg_net).
-- The export job secret is generated INSIDE the database (vault) — it never exists in the repo or chat.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- public-read bucket for the export files (this is the designated bulk path).
-- No storage.objects policies → anon cannot list, upload or delete; only public GET of objects.
insert into storage.buckets (id, name, public) values ('export', 'export', true)
on conflict (id) do nothing;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'aua_export_secret',
                           'auth header for the daily export job')
where not exists (select 1 from vault.secrets where name = 'aua_export_secret');

create function public.aua_export_auth(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets
                  where name = 'aua_export_secret' and decrypted_secret = p_secret)
$$;
revoke execute on function public.aua_export_auth(text) from public, anon, authenticated;
grant execute on function public.aua_export_auth(text) to service_role;

select cron.schedule('aua-export-daily', '10 0 * * *', $job$
  select net.http_post(
    url     := 'https://hjrnskmovwjtaifidldw.supabase.co/functions/v1/export',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-aua-export', (select decrypted_secret from vault.decrypted_secrets where name = 'aua_export_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000)
$job$);

select cron.schedule('aua-housekeep', '20 0 * * *', $job$ select public.aua_housekeep() $job$);
