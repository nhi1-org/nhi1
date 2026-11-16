-- NHI-1 AUA · 0013: the wall read quota gets its own knobs and its own buckets (4_ §7: 讀牆另設一格).
-- 0012 reused the write quota's knob names (w_ip_hour / w_key_hour, so `on conflict do nothing` kept the
-- write values 200 / 120) and its buckets (wi: / wk:, so a wall read used up write quota and back).
-- Write quota and its knobs are untouched. No schema change (aua hash unchanged).

insert into public.knob (name, val) values ('wl_ip_hour', 120), ('wl_key_hour', 30) on conflict (name) do nothing;

create or replace function public.aua_gate_wall(p_ip text, p_key text) returns int language plpgsql as $$
declare ok boolean := true;
begin
  ok := public.aua_hit('li:' || p_ip, 3600, public.aua_knob('wl_ip_hour')) and ok;
  ok := public.aua_hit('lk:' || p_key, 3600, public.aua_knob('wl_key_hour')) and ok;
  return case when ok then 0 else 7 end;
end $$;

revoke execute on function public.aua_gate_wall(text, text) from public, anon, authenticated;
grant execute on function public.aua_gate_wall(text, text) to service_role;
