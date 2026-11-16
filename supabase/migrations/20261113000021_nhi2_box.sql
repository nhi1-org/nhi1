-- NHI-2 · 0021: the key box (鑰匙放國度, card §10; 寓言 11/13 審過：門鑰簽名、忘時連密碼一起換、防回捲).
-- One row per citizen: its public key, the public key of its door (derived on the body side from the citizen's
-- password), the box version and the box ciphertext. The root cannot open the box (no wrap key) and never sees
-- the password. Not append-only: a new box overwrites the old one in place (that is how forgetting works).
-- Not in export, replica, ask, wall, weight or the daily report; anon / authenticated see nothing.
-- Own knobs (box_* / b_*), own buckets (bg: bgi: bp: bni: bn). 【暫，CODE 建議】 unless noted.

create table public.mem_box (
  pub   text primary key check (pub ~ '^[0-9a-f]{64}$'),   -- the citizen's signing public key
  door  text not null unique check (door ~ '^[0-9a-f]{64}$'), -- the door's public key (proves "this box is mine")
  ver   bigint not null check (ver >= 1),
  size  int  not null check (size > 0),
  box   text not null,                                       -- base64url(iv || AES-256-GCM(box) || tag)
  at    timestamptz not null default now()
);
alter table public.mem_box enable row level security;
revoke all on public.mem_box from public, anon, authenticated, service_role;
grant select, insert, update on public.mem_box to service_role;

insert into public.knob (name, val) values
  ('box_write_on',     1),      -- 0 = no new or changed boxes; reads still work
  ('b_bytes',      16384),      -- one box's ciphertext
  ('b_get_hour',     240),      -- box reads per door per hour: the hook opens it only for a record that goes (NHI-1 writes: 120 per key per hour)
  ('b_get_ip_hour', 1200),      -- box reads per IP per hour
  ('b_put_day',       24),      -- box changes per citizen per UTC day
  ('b_new_ip_day',    20),      -- new boxes per IP per day
  ('b_new_day',     1000)       -- new boxes per UTC day, whole root
on conflict (name) do nothing;

-- read: the box for this door → { pub, ver, box } | { err: 48 }
create function public.aua_box_get(p_door text, p_ip text) returns jsonb language plpgsql as $$
declare ok boolean := true; b record;
begin
  ok := public.aua_hit('bg:' || p_door, 3600, public.aua_knob('b_get_hour')) and ok;
  ok := public.aua_hit('bgi:' || p_ip, 3600, public.aua_knob('b_get_ip_hour')) and ok;
  if not ok then return jsonb_build_object('err', 7); end if;
  select * into b from public.mem_box where door = p_door;
  if not found then return jsonb_build_object('err', 48); end if;
  return jsonb_build_object('pub', b.pub, 'ver', b.ver, 'box', b.box);
end $$;

-- write. The handler has checked shape and all signatures (door, next door, citizen).
--   no row for pub: a new box — ver must be 1, next = door, neither key in use.
--   a row for pub: door must be its door and ver its ver + 1; the door moves to next (a new password) or stays.
-- → { ver } | { err }: 2 too large, 7 rate, 44 writes off, 49 wrong ver / door, 50 key or door taken
create function public.aua_box_put(p_door text, p_next text, p_pub text, p_ver bigint, p_box text, p_size int, p_ip text)
returns jsonb language plpgsql as $$
declare ok boolean := true; b record; v_n int;
begin
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

revoke execute on function public.aua_box_get(text, text), public.aua_box_put(text, text, text, bigint, text, int, text)
  from public, anon, authenticated;
grant execute on function public.aua_box_get(text, text), public.aua_box_put(text, text, text, bigint, text, int, text)
  to service_role;
