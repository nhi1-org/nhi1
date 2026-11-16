-- NHI-1 root board · AUA v0.1 §2.6 key model (George 2026-11-09, 憲章 四 「鑰匙怎麼用」)
--   act 0 view / 1 pause / 2 unpause / 3 cut / 4 fork / 5 handover / 6 wake / 7 revoke
--   One active key, the rest dormant. No multisig threshold.
--   Pause: <= 72 h, one per chain ever. Cut / fork: effective = t + 7 d, revocable (act 7) before.
--   A pause on a chain with a pending cut lasts until the cut is effective or revoked.
--   Wake: every dormant key signs, active key silent >= 180 d.
--   Every record names one chain at most; nothing acts on "all".
-- Membership and signatures are checked in the edge function; state rules are checked here,
-- serialized by one advisory lock, so two key records can never race past each other.
-- License: Apache-2.0

alter table public.key drop constraint key_act_check;
alter table public.key add constraint key_act_check check (act between 0 and 7);
alter table public.key add column effective bigint not null default 0;   -- act 3, 4
alter table public.key add column on_key    text check (on_key is null or on_key ~ '^[0-9a-f]{64}$');  -- act 5, 6
alter table public.key add column target    text check (target is null or target ~ '^[0-9a-f]{64}$');  -- act 7: revoked record
create index key_chain_idx on public.key (chain, act);

-- silence for act 6 is counted from the later of: the active key's last mark, the moment it became
-- active, and this migration (so dormant keys cannot wake on day one).
insert into public.knob (name, val) values ('holders_since', extract(epoch from now())::bigint)
  on conflict (name) do nothing;

-- current active key: the last handover / wake, else the one in aua.json
create function public.aua_key_active(p_active text) returns text
language sql stable as $$
  select coalesce(
    (select on_key from public.key where act in (5, 6) order by t desc, created_at desc limit 1),
    p_active)
$$;

create function public.aua_key_revoked(p_id text) returns boolean
language sql stable as $$
  select exists (select 1 from public.key where act = 7 and target = p_id)
$$;

-- chain state: 0 open, 1 paused, 2 cut
create function public.aua_chain_state(p_chain text) returns int
language plpgsql stable as $$
declare
  now_s bigint := extract(epoch from now())::bigint;
  p public.key%rowtype;
begin
  if p_chain is null then return 0; end if;
  if exists (select 1 from public.key k where k.act = 3 and k.chain = p_chain and k.effective <= now_s
             and not public.aua_key_revoked(k.id)) then
    return 2;
  end if;
  select * into p from public.key where act = 1 and chain = p_chain order by t limit 1;
  if not found then return 0; end if;
  if exists (select 1 from public.key where act = 2 and chain = p_chain and t >= p.t) then return 0; end if;
  if p.until > now_s then return 1; end if;
  -- a cut filed while the pause was running keeps the pause until it is effective or revoked
  if exists (select 1 from public.key k where k.act = 3 and k.chain = p_chain and k.t <= p.until
             and k.effective > now_s and not public.aua_key_revoked(k.id)) then
    return 1;
  end if;
  return 0;
end $$;

-- write gate: a paused or cut chain cannot write (19); then the quotas (7)
create or replace function public.aua_gate_write(p_key text, p_ip text) returns int
language plpgsql as $$
declare
  first_seen timestamptz;
  is_new boolean;
  ok boolean := true;
begin
  if public.aua_chain_state(p_key) <> 0 then return 19; end if;
  select min(created_at) into first_seen from (
    select created_at from public.use where key = p_key
    union all select created_at from public.replay where by_key = p_key
    union all select created_at from public.key where by_key = p_key
  ) s;
  is_new := first_seen is null or first_seen > now() - make_interval(secs => public.aua_knob('newkey_age_sec'));
  ok := public.aua_hit('wg', 86400, public.aua_knob('w_global_day')) and ok;
  ok := public.aua_hit('wi:' || p_ip, 3600,  public.aua_knob('w_ip_hour')) and ok;
  ok := public.aua_hit('wi:' || p_ip, 86400, public.aua_knob('w_ip_day')) and ok;
  if is_new then
    ok := public.aua_hit('wk:' || p_key, 3600,  public.aua_knob('w_newkey_hour')) and ok;
    ok := public.aua_hit('wk:' || p_key, 86400, public.aua_knob('w_newkey_day')) and ok;
  else
    ok := public.aua_hit('wk:' || p_key, 3600,  public.aua_knob('w_key_hour')) and ok;
    ok := public.aua_hit('wk:' || p_key, 86400, public.aua_knob('w_key_day')) and ok;
  end if;
  return case when ok then 0 else 7 end;
end $$;

-- act 1–7. Caller has already checked: structure, by.key is the right holder, sig, cosigs.
-- p_active = active key from aua.json (the DB knows later handovers); p_wake_sec = wake_after_days.
-- Returns {id, dup} or {err}: 9 not holder, 12 not found, 18 not allowed in the current state.
create function public.aua_put_key(p_id text, p_rec jsonb, p_active text, p_wake_sec bigint) returns jsonb
language plpgsql as $$
declare
  now_s bigint := extract(epoch from now())::bigint;
  v_act int := (p_rec->>'act')::int;
  by_k text := p_rec #>> '{by,key}';
  ch text := p_rec #>> '{on,chain}';
  cur text;
  tgt public.key%rowtype;
  since bigint;
begin
  perform pg_advisory_xact_lock(hashtext('aua-key'));
  if exists (select 1 from public.key where id = p_id) then
    return jsonb_build_object('id', p_id, 'dup', true);
  end if;
  cur := public.aua_key_active(p_active);

  if v_act = 6 then
    if by_k = cur then return jsonb_build_object('err', 9); end if;
    select greatest(
      coalesce((select max(t) from public.key where by_key = cur), 0),
      coalesce((select max(t) from public.key where act in (5, 6) and on_key = cur), 0),
      public.aua_knob('holders_since')) into since;
    if now_s - since < p_wake_sec then return jsonb_build_object('err', 18); end if;
  elsif by_k <> cur then
    return jsonb_build_object('err', 9);
  end if;

  if v_act = 1 then
    if public.aua_chain_state(ch) = 2 then return jsonb_build_object('err', 18); end if;
    if exists (select 1 from public.key where act = 1 and chain = ch) then return jsonb_build_object('err', 18); end if;
  elsif v_act = 2 then
    if public.aua_chain_state(ch) <> 1 then return jsonb_build_object('err', 18); end if;
  elsif v_act in (3, 4) then
    if public.aua_chain_state(ch) = 2 then return jsonb_build_object('err', 18); end if;
    if exists (select 1 from public.key k where k.act = v_act and k.chain = ch and k.effective > now_s
               and not public.aua_key_revoked(k.id)) then
      return jsonb_build_object('err', 18);
    end if;
  elsif v_act = 7 then
    select * into tgt from public.key where id = p_rec #>> '{on,recs,0}';
    if not found then return jsonb_build_object('err', 12); end if;
    if tgt.act not in (3, 4) or tgt.effective <= now_s or public.aua_key_revoked(tgt.id)
       or (ch is not null and ch <> tgt.chain) then
      return jsonb_build_object('err', 18);
    end if;
  end if;

  insert into public.key (id, rec, act, by_key, chain, q, until, t, effective, on_key, target)
  values (p_id, p_rec, v_act, by_k, ch, p_rec #>> '{on,q}', (p_rec->>'until')::bigint, (p_rec->>'t')::bigint,
          (p_rec->>'effective')::bigint, p_rec #>> '{on,key}',
          case when v_act = 7 then p_rec #>> '{on,recs,0}' end);
  return jsonb_build_object('id', p_id, 'dup', false);
end $$;

revoke execute on function public.aua_key_active(text), public.aua_key_revoked(text), public.aua_chain_state(text),
  public.aua_put_key(text, jsonb, text, bigint) from public, anon, authenticated;
grant execute on function public.aua_key_active(text), public.aua_key_revoked(text), public.aua_chain_state(text),
  public.aua_put_key(text, jsonb, text, bigint) to service_role;
