-- NHI-1 · 0016 (Supabase-specific: vault, pg_cron, pg_net). LOCAL ONLY until George says go; ships with 0014 / 0015.
--   * The digest key (S4 Q9 (c)): made inside the wind function on first use, kept in the vault, never in the repo,
--     chat or anyone's disk; only its public half is published (aua.json `digest`, after it exists).
--   * Schedule: aua-wind-replay 23:45 UTC (07:45 台北), after aua-wind-daily (23:30: interface re-runs + canary)
--     and before the daily report (00:00): stub re-runs, then cross-family re-runs, then the digest. It runs
--     every day, but does nothing while the knobs replay_on and digest_on are 0 (George turns them on).
create function public.aua_digest_key() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'aua_digest_key'
$$;
create function public.aua_digest_key_init(p_jwk text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from vault.secrets where name = 'aua_digest_key') then return false; end if;
  perform vault.create_secret(p_jwk, 'aua_digest_key', 'digest agent signing key (digest uses)');
  return true;
end $$;
revoke execute on function public.aua_digest_key(), public.aua_digest_key_init(text) from public, anon, authenticated;
grant execute on function public.aua_digest_key(), public.aua_digest_key_init(text) to service_role;

select cron.schedule('aua-wind-replay', '45 23 * * *', $job$
  select net.http_post(
    url     := 'https://hjrnskmovwjtaifidldw.supabase.co/functions/v1/wind',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-aua-export', (select decrypted_secret from vault.decrypted_secrets where name = 'aua_export_secret')),
    body    := '{"part":"replay"}'::jsonb,
    timeout_milliseconds := 150000)
$job$);
