-- NHI-1 · the wind key (schema batch; Supabase-specific: vault). LOCAL BRANCH ONLY until it ships.
-- The wind tunnel signs report records with its own Ed25519 key. The key is made inside the edge function on
-- first use and kept in the vault: it never exists in the repo, in chat, or on anyone's disk. Only its public
-- half is published (aua.json `wind`).
create function public.aua_wind_key() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'aua_wind_key'
$$;
create function public.aua_wind_key_init(p_jwk text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from vault.secrets where name = 'aua_wind_key') then return false; end if;
  perform vault.create_secret(p_jwk, 'aua_wind_key', 'wind tunnel signing key (report records)');
  return true;
end $$;
revoke execute on function public.aua_wind_key(), public.aua_wind_key_init(text) from public, anon, authenticated;
grant execute on function public.aua_wind_key(), public.aua_wind_key_init(text) to service_role;
