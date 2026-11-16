-- NHI-1 · TALK BATCH (local branch s3-talk, NOT deployed): the talk write endpoint (AUA 2_ §2.4).
--   * about may be empty (George 11/09 深夜): {thing: null, use: null} = the graffiti board (塗鴉板);
--     hung on a thing or a use = the professional board. The core check "must hang on something" goes.
--   * talk is its own quota (t_* knobs), apart from the write quota of use / replay.
--   * talk rides the same chain as use / replay (prev, chain_head, err 21); at_t (exact second) stays in the root.
--   * the canary scans talk text: rule-certain hits never reach this function (the handler refuses them);
--     rule suspects are stored and wait in talk_canary for the model (wind run), with fallback; a model
--     "instruction" (or no model: flagged unjudged) marks the talk. What a flag then does (not served,
--     chain weight) waits for George (talk batch part 2, question C). Flags are cleared only by the canary.
--   * talk never enters view, weight or stub: aua_ask reads only use / replay. Nothing here changes it.
--   * part 2 (George 11/12): every talk gets a canary row; a flag is live (computed, never stored as an act):
--     a flagged talk is not served, its signer's talk ordering is 0, its uses are untouched. Flags travel as
--     talk_flag records signed by the wind key (in the replica). Talk rules version up -> every talk rescanned.
--     kind 5 = sign-in ("I'm here"): about empty, text empty, prev null. The wall read (aua_wall): signed, <= 5,
--     ordered by the signer's talk ordering.

-- ── graffiti: about may be empty ──
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.talk'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%about_thing%about_use%'
  loop
    execute format('alter table public.talk drop constraint %I', c);
  end loop;
end $$;
create index talk_key_idx   on public.talk (key, created_at);
create index talk_thing_idx on public.talk (about_thing) where about_thing is not null;
create index talk_use_idx   on public.talk (about_use) where about_use is not null;

-- ── the talk quota (a separate bucket; start values, knobs, no redeploy to change) ──
insert into public.knob (name, val) values
  ('t_global_day',   3000),   -- all talk, whole board, per UTC day
  ('t_ip_hour',        60), ('t_ip_day',      300),
  ('t_key_hour',       12), ('t_key_day',      60),
  ('t_newkey_hour',     4), ('t_newkey_day',   12)   -- "new" = first record younger than newkey_age_sec
on conflict (name) do nothing;

create function public.aua_gate_talk(p_key text, p_ip text) returns int
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
    union all select created_at from public.talk where key = p_key
    union all select created_at from public.key where by_key = p_key
  ) s;
  is_new := first_seen is null or first_seen > now() - make_interval(secs => public.aua_knob('newkey_age_sec'));
  ok := public.aua_hit('tg', 86400, public.aua_knob('t_global_day')) and ok;
  ok := public.aua_hit('ti:' || p_ip, 3600,  public.aua_knob('t_ip_hour')) and ok;
  ok := public.aua_hit('ti:' || p_ip, 86400, public.aua_knob('t_ip_day')) and ok;
  if is_new then
    ok := public.aua_hit('tk:' || p_key, 3600,  public.aua_knob('t_newkey_hour')) and ok;
    ok := public.aua_hit('tk:' || p_key, 86400, public.aua_knob('t_newkey_day')) and ok;
  else
    ok := public.aua_hit('tk:' || p_key, 3600,  public.aua_knob('t_key_hour')) and ok;
    ok := public.aua_hit('tk:' || p_key, 86400, public.aua_knob('t_key_day')) and ok;
  end if;
  return case when ok then 0 else 7 end;
end $$;

-- ── the canary on talk (internal; never exported) ──
-- state 0 = suspect, waits for the model · 1 = clear (model: documentation) · 2 = flagged
-- how: 'model' (the model said instruction) · 'unsure' (the model could not tell) · 'unjudged' (no model, flagged to be safe)
create table public.talk_canary (
  talk_id    text primary key references public.talk(id),
  suspect    smallint[] not null,
  rv         int not null,                      -- rules version of the scan (canary.ts RULES_V)
  state      smallint not null default 0 check (state between 0 and 2),
  how        text,
  judged_at  timestamptz,
  created_at timestamptz not null default now()
);
alter table public.talk_canary enable row level security;
revoke all on public.talk_canary from public, anon, authenticated;
grant select, insert, update on public.talk_canary to service_role;

-- talk waiting for the model: suspects never judged, then unjudged flags (re-judged when a model is there)
create function public.aua_talk_to_judge(p_lim int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'text', s.text, 'suspect', s.suspect, 'state', s.state, 'how', s.how)), '[]'::jsonb) from (
    select t.id, t.rec->>'text' as text, c.suspect, c.state, c.how
      from public.talk_canary c join public.talk t on t.id = c.talk_id
     where c.state = 0 or (c.state = 2 and c.how = 'unjudged')
     order by c.state, c.created_at
     limit p_lim) s
$$;

-- returns the state before (null: no such talk), so the wind run knows when to sign a flag record
create function public.aua_talk_judged(p_id text, p_state int, p_how text) returns int
language plpgsql as $$
declare old int;
begin
  select state into old from public.talk_canary where talk_id = p_id for update;
  update public.talk_canary set state = p_state, how = p_how, judged_at = now() where talk_id = p_id;
  return old;
end $$;

-- ── put one talk (structure, both signatures, PII and the canary's certain rules are checked by the caller) ──
-- returns {dup} | {err: 12} (about.use not on the board) | {err: 21, head} (chain collision)
create function public.aua_put_talk(p_id text, p_rec jsonb, p_thing_id text, p_at bigint, p_suspect jsonb, p_rv int)
returns jsonb language plpgsql as $$
declare c jsonb;
begin
  if exists (select 1 from public.talk where id = p_id) then return jsonb_build_object('dup', true); end if;
  if p_rec #>> '{about,use}' is not null and not exists (select 1 from public.use where id = p_rec #>> '{about,use}') then
    return jsonb_build_object('err', 12);
  end if;
  c := public.aua_chain_take(p_rec #>> '{by,key}', p_rec->>'prev', p_id);
  if c is not null then return c || jsonb_build_object('dup', false); end if;

  if p_thing_id is not null then
    insert into public.thing (id, addr, iface)
    values (p_thing_id, p_rec #>> '{about,thing,addr}', p_rec #>> '{about,thing,iface}')
    on conflict do nothing;
  end if;
  insert into public.talk (id, rec, about_thing, about_use, kind, key, t, at_t)
  values (p_id, p_rec, p_thing_id, p_rec #>> '{about,use}', (p_rec->>'kind')::smallint,
          p_rec #>> '{by,key}', (p_rec->>'t')::bigint, p_at);
  -- every talk gets a canary row (hole 5: a new rules version rescans all talk, not only suspects):
  -- suspects wait for the model (state 0, not served yet); no hit = clear by the rules (state 1)
  insert into public.talk_canary (talk_id, suspect, rv, state, how, judged_at)
  select p_id, array(select (jsonb_array_elements_text(coalesce(p_suspect, '[]'::jsonb)))::smallint), p_rv,
         case when jsonb_array_length(coalesce(p_suspect, '[]'::jsonb)) > 0 then 0 else 1 end,
         case when jsonb_array_length(coalesce(p_suspect, '[]'::jsonb)) > 0 then null else 'rules' end,
         case when jsonb_array_length(coalesce(p_suspect, '[]'::jsonb)) > 0 then null else now() end;
  return jsonb_build_object('dup', false);
end $$;

revoke execute on function public.aua_gate_talk(text, text), public.aua_talk_to_judge(int), public.aua_talk_judged(text, int, text),
  public.aua_put_talk(text, jsonb, text, bigint, jsonb, int) from public, anon, authenticated;
grant execute on function public.aua_gate_talk(text, text), public.aua_talk_to_judge(int), public.aua_talk_judged(text, int, text),
  public.aua_put_talk(text, jsonb, text, bigint, jsonb, int) to service_role;

-- == part 2 (George 11/12) ==================================================================================

-- -- kind 5 = sign-in, "I'm here": no about, no text, the first record of its key (prev null) --
alter table public.talk drop constraint if exists talk_kind_check;
alter table public.talk add constraint talk_kind_check check (kind between 0 and 5);
alter table public.talk add constraint talk_signin_check check (
  kind <> 5 or (about_thing is null and about_use is null and rec->>'text' = '' and jsonb_typeof(rec->'prev') = 'null'));

-- a canary row for any talk that has none yet (rv 0: the next wind run rescans it)
insert into public.talk_canary (talk_id, suspect, rv, state, how)
select id, '{}', 0, 1, 'rules' from public.talk t where not exists (select 1 from public.talk_canary c where c.talk_id = t.id);

-- -- rescan (hole 5): every talk scanned under an older talk rules version --
create function public.aua_talk_to_rescan(p_rv int, p_lim int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'text', s.text, 'state', s.state, 'how', s.how)), '[]'::jsonb) from (
    select t.id, t.rec->>'text' as text, c.state, c.how
      from public.talk_canary c join public.talk t on t.id = c.talk_id
     where c.rv < p_rv
     order by c.created_at
     limit p_lim) s
$$;
-- returns the state before
create function public.aua_talk_rescanned(p_id text, p_state int, p_how text, p_rules jsonb, p_rv int) returns int
language plpgsql as $$
declare old int;
begin
  select state into old from public.talk_canary where talk_id = p_id for update;
  update public.talk_canary
     set state = p_state, how = p_how, rv = p_rv, judged_at = case when p_state = 0 then null else now() end,
         suspect = array(select (jsonb_array_elements_text(coalesce(p_rules, '[]'::jsonb)))::smallint)
   where talk_id = p_id;
  return old;
end $$;

-- -- flags travel as records (hole 4): signed by the wind key, append-only, in the export / replica --
-- state 2 = flagged, 1 = cleared. The live flag of a talk is its latest talk_flag record.
create table public.talk_flag (
  id      text primary key check (id ~ '^[0-9a-f]{64}$'),
  rec     jsonb not null,
  talk_id text not null references public.talk(id),
  state   smallint not null check (state in (1, 2)),
  by_key  text not null check (by_key ~ '^[0-9a-f]{64}$'),
  t       bigint not null,
  created_at timestamptz not null default now()
);
create index talk_flag_talk_idx on public.talk_flag (talk_id, t desc, created_at desc);
create trigger talk_flag_no_change before update or delete on public.talk_flag for each row execute function public.aua_append_only();
create trigger talk_flag_no_truncate before truncate on public.talk_flag for each statement execute function public.aua_append_only();
alter table public.talk_flag enable row level security;
revoke all on public.talk_flag from public, anon, authenticated, service_role;
grant select, insert on public.talk_flag to service_role;

create function public.aua_put_talk_flag(p_id text, p_rec jsonb) returns boolean language plpgsql as $$
begin
  insert into public.talk_flag (id, rec, talk_id, state, by_key, t)
  values (p_id, p_rec, p_rec->>'talk', (p_rec->>'state')::smallint, p_rec #>> '{by,key}', (p_rec->>'t')::bigint)
  on conflict (id) do nothing;
  return found;
end $$;

-- -- the talk ordering of a key (holes 1-3): computed now from the live flags, never stored as an act --
-- = the passes of the key's uses in the wind tunnel's cross-family re-runs (rpf: replay_result.fam set;
-- George 11/12: interface re-runs and same-family re-runs do not count); 0 while any of its talk is
-- flagged; back as soon as the flag is cleared. Its uses and their weight are untouched.
create function public.aua_talk_w(p_key text) returns bigint language sql stable as $$
  select case when exists (select 1 from public.talk t join public.talk_canary c on c.talk_id = t.id
                            where t.key = p_key and c.state = 2) then 0
         else (select count(*) from public.replay_result rr join public.replay r on r.id = rr.req_id
                 join public.use u on u.id = r.use_id where u.key = p_key and rr.pass and rr.fam is not null) end
$$;

-- -- the wall read (2_ 2.4 reading rule): <= 5 talks, served only when the canary has cleared them --
-- p_thing / p_use: the board to read; both null = graffiti. Sign-ins (kind 5) carry no text and are not served.
-- refs: 64-hex ids in the text that are records on the board (evidence the reader may cite; <= 4)
create function public.aua_wall(p_thing text, p_use text, p_lim int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'rec', s.rec, 'refs', s.refs) order by s.w desc, s.t desc, s.id), '[]'::jsonb)
  from (
    select t.id, t.rec, t.t, public.aua_talk_w(t.key) as w,
           coalesce((select jsonb_agg(q.m) from (
              select distinct x[1] as m from regexp_matches(t.rec->>'text', '[0-9a-f]{64}', 'g') x
               where exists (select 1 from public.use where id = x[1]) or exists (select 1 from public.talk where id = x[1])
                  or exists (select 1 from public.replay where id = x[1]) or exists (select 1 from public.thing where id = x[1])
               limit 4) q), '[]'::jsonb) as refs
      from public.talk t join public.talk_canary c on c.talk_id = t.id
     where c.state = 1 and t.kind <> 5
       and ((p_thing is null and p_use is null and t.about_thing is null and t.about_use is null)
            or ((p_thing is not null or p_use is not null)
                and (p_thing is null or t.about_thing = p_thing) and (p_use is null or t.about_use = p_use)))
     order by public.aua_talk_w(t.key) desc, t.t desc, t.id
     limit least(greatest(p_lim, 1), 5)
  ) s
$$;

insert into public.knob (name, val) values ('w_ip_hour', 120), ('w_key_hour', 30) on conflict (name) do nothing;
create function public.aua_gate_wall(p_ip text, p_key text) returns int language plpgsql as $$
declare ok boolean := true;
begin
  ok := public.aua_hit('wi:' || p_ip, 3600, public.aua_knob('w_ip_hour')) and ok;
  ok := public.aua_hit('wk:' || p_key, 3600, public.aua_knob('w_key_hour')) and ok;
  return case when ok then 0 else 7 end;
end $$;

-- -- export: table 6 = talk_flag --
create or replace function public.aua_export_page(p_table int, p_after text, p_lim int) returns jsonb
language plpgsql stable as $$
declare rows jsonb;
begin
  if p_table = 0 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', jsonb_build_object('addr', addr, 'iface', iface)) x
        from public.thing where id > p_after order by id limit p_lim) s;
  elsif p_table = 1 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.use where id > p_after order by id limit p_lim) s;
  elsif p_table = 2 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.talk where id > p_after order by id limit p_lim) s;
  elsif p_table = 3 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.key where id > p_after order by id limit p_lim) s;
  elsif p_table = 4 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.replay where id > p_after order by id limit p_lim) s;
  elsif p_table = 5 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.report where id > p_after order by id limit p_lim) s;
  else
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.talk_flag where id > p_after order by id limit p_lim) s;
  end if;
  return rows;
end $$;

-- -- the daily numbers: canary counts talk flags too; zeroed = keys whose talk ordering a new flag set to 0 --
alter function public.aua_report_numbers(timestamptz, timestamptz) rename to aua_report_numbers_0006;
create function public.aua_report_numbers(p_from timestamptz, p_to timestamptz) returns jsonb language sql stable as $$
  select b || jsonb_build_object(
    'canary', (b->>'canary')::bigint
            + (select count(*) from public.talk_flag where state = 2 and created_at >= p_from and created_at < p_to),
    'zeroed', (select count(distinct t.key) from public.talk_flag f join public.talk t on t.id = f.talk_id
                where f.state = 2 and f.created_at >= p_from and f.created_at < p_to))
  from (select public.aua_report_numbers_0006(p_from, p_to) as b) x
$$;

revoke execute on function public.aua_talk_to_rescan(int, int), public.aua_talk_rescanned(text, int, text, jsonb, int),
  public.aua_put_talk_flag(text, jsonb), public.aua_talk_w(text), public.aua_wall(text, text, int), public.aua_gate_wall(text, text),
  public.aua_report_numbers(timestamptz, timestamptz), public.aua_report_numbers_0006(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.aua_talk_to_rescan(int, int), public.aua_talk_rescanned(text, int, text, jsonb, int),
  public.aua_put_talk_flag(text, jsonb), public.aua_talk_w(text), public.aua_wall(text, text, int), public.aua_gate_wall(text, text),
  public.aua_report_numbers(timestamptz, timestamptz), public.aua_report_numbers_0006(timestamptz, timestamptz)
  to service_role;
