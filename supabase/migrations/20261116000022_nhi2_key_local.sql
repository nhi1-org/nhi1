-- NHI-2 · 0022: the key moves to the body side (George 11/16: 鑰匙存本機、分散存放；國度只記 ID，不記 KEY).
-- The citizen's key is made and kept on its own machine (three pieces); the root keeps only its public half,
-- which is the citizen's id, and checks signatures with it. Nothing here can sign or open a memory.
--   mem_room: one row per registered room: the public key and the UTC day it was registered. Nothing else
--             (no IP, no user, no machine). Not in export, replica, ask, wall, weight or the daily report.
--   box_on:   the old key box (0021) stays readable while the citizens of this machine move out; then 0 closes
--             it (err 51), and the moved boxes are deleted by hand.
-- 【暫，CODE 建議】 the numbers.

create table public.mem_room (
  pub text primary key check (pub ~ '^[0-9a-f]{64}$'),  -- the citizen's raw Ed25519 public key = its id
  day bigint not null check (day % 86400 = 0)           -- UTC day of the registration
);
alter table public.mem_room enable row level security;
revoke all on public.mem_room from public, anon, authenticated, service_role;
grant select, insert on public.mem_room to service_role;

insert into public.knob (name, val) values
  ('room_on',          1),   -- 0 = no new rooms registered; existing rooms work as before
  ('r_new_ip_day',    20),   -- new rooms per IP per UTC day
  ('r_new_day',     1000),   -- new rooms per UTC day, whole root
  ('box_on',           1)    -- 0 = the old key box is closed: box_get / box_put answer err 51
on conflict (name) do nothing;

-- register a room. The handler has checked the request's signature with p_pub (whoever signs holds the key).
-- → { room: 1, new: 0 | 1 } | { err: 7 rate, 44 off }
create function public.aua_room_reg(p_pub text, p_ip text) returns jsonb language plpgsql as $$
declare ok boolean := true; v_day bigint := (floor(extract(epoch from now()) / 86400) * 86400)::bigint;
begin
  if exists (select 1 from public.mem_room where pub = p_pub) then return jsonb_build_object('room', 1, 'new', 0); end if;
  if coalesce(public.aua_knob('room_on'), 0) = 0 then return jsonb_build_object('err', 44); end if;
  ok := public.aua_hit('rni:' || p_ip, 86400, public.aua_knob('r_new_ip_day')) and ok;
  ok := public.aua_hit('rn', 86400, public.aua_knob('r_new_day')) and ok;
  if not ok then return jsonb_build_object('err', 7); end if;
  insert into public.mem_room (pub, day) values (p_pub, v_day) on conflict (pub) do nothing;
  return jsonb_build_object('room', 1, 'new', 1);
end $$;

-- read only (the verify-only check): is this id a registered room? Writes nothing.
create function public.aua_room_has(p_pub text) returns boolean language sql stable as $$
  select exists (select 1 from public.mem_room where pub = p_pub)
$$;

-- the old box, now behind box_on (same bodies as 0021 otherwise)
create or replace function public.aua_box_get(p_door text, p_ip text) returns jsonb language plpgsql as $$
declare ok boolean := true; b record;
begin
  if coalesce(public.aua_knob('box_on'), 0) = 0 then return jsonb_build_object('err', 51); end if;
  ok := public.aua_hit('bg:' || p_door, 3600, public.aua_knob('b_get_hour')) and ok;
  ok := public.aua_hit('bgi:' || p_ip, 3600, public.aua_knob('b_get_ip_hour')) and ok;
  if not ok then return jsonb_build_object('err', 7); end if;
  select * into b from public.mem_box where door = p_door;
  if not found then return jsonb_build_object('err', 48); end if;
  return jsonb_build_object('pub', b.pub, 'ver', b.ver, 'box', b.box);
end $$;

create or replace function public.aua_box_put(p_door text, p_next text, p_pub text, p_ver bigint, p_box text, p_size int, p_ip text)
returns jsonb language plpgsql as $$
declare ok boolean := true; b record; v_n int;
begin
  if coalesce(public.aua_knob('box_on'), 0) = 0 then return jsonb_build_object('err', 51); end if;
  if coalesce(public.aua_knob('box_write_on'), 0) = 0 then return jsonb_build_object('err', 44); end if;
  if p_size > public.aua_knob('b_bytes') then return jsonb_build_object('err', 2); end if;
  select * into b from public.mem_box where pub = p_pub for update;
  if not found then
    if p_ver <> 1 or p_next <> p_door then return jsonb_build_object('err', 49); end if;
    if exists (select 1 from public.mem_box where door = p_door) then return jsonb_build_object('err', 50); end if;
    ok := public.aua_hit('bni:' || p_ip, 86400, public.aua_knob('b_new_ip_day')) and ok;
    ok := public.aua_hit('bn', 86400, public.aua_knob('b_new_day')) and ok;
    ok := public.aua_hit('bp:' || p_pub, 86400, public.aua_knob('b_put_day')) and ok;
    if not ok then return jsonb_build_object('err', 7); end if;
    insert into public.mem_box (pub, door, ver, size, box) values (p_pub, p_door, 1, p_size, p_box);
    return jsonb_build_object('ver', 1);
  end if;
  if b.door <> p_door or p_ver <> b.ver + 1 then return jsonb_build_object('err', 49); end if;
  if p_next <> p_door and exists (select 1 from public.mem_box where door = p_next) then return jsonb_build_object('err', 50); end if;
  if not public.aua_hit('bp:' || p_pub, 86400, public.aua_knob('b_put_day')) then return jsonb_build_object('err', 7); end if;
  update public.mem_box set door = p_next, ver = p_ver, size = p_size, box = p_box, at = now()
   where pub = p_pub and door = p_door and ver = p_ver - 1;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('err', 49); end if;
  return jsonb_build_object('ver', p_ver);
end $$;

revoke execute on function public.aua_room_reg(text, text), public.aua_room_has(text) from public, anon, authenticated;
grant execute on function public.aua_room_reg(text, text), public.aua_room_has(text) to service_role;
revoke execute on function public.aua_box_get(text, text), public.aua_box_put(text, text, text, bigint, text, int, text)
  from public, anon, authenticated;
grant execute on function public.aua_box_get(text, text), public.aua_box_put(text, text, text, bigint, text, int, text)
  to service_role;
