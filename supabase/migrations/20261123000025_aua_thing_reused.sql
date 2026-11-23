-- NHI-1 · 0025 board fix, follow-up (Opus 11/23): an interface judged gone that gets a new use record is usable again.
--   * thing_state gains state 2 「重新可用」: added (never changed) when a use pointing at a thing judged gone is written.
--     The thing is back in the checks and the report says it once. Old rows stay as they are.
--   * a state row starts a fresh streak: unreachable after it is "first unreachable" again (yellow once), and the
--     7-day count starts after it, so a thing used again is not judged gone again the same night.
-- License: Apache-2.0

alter table public.thing_state drop constraint thing_state_state_check;
alter table public.thing_state add constraint thing_state_state_check check (state in (0, 1, 2)); -- 1 judged gone · 0 answers again · 2 used again

create function public.aua_use_reuse() returns trigger language plpgsql as $$
begin
  if public.aua_thing_gone(new.thing_id, 'infinity') then
    insert into public.thing_state (thing_id, state, days) values (new.thing_id, 2, 0);
  end if;
  return new;
end $$;
create trigger use_reuse after insert on public.use for each row execute function public.aua_use_reuse();

-- the streak starts after the last answered check AND after the thing's last state row
create or replace function public.aua_unreach_days(p_thing text, p_at timestamptz) returns int language sql stable as $$
  with c as (select id, at, result from public.wind_check where thing_id = p_thing and at < p_at),
       last as (select result from c order by at desc, id desc limit 1),
       since as (select greatest(
                   (select max(at) from c where result <> 3),
                   (select max(at) from public.thing_state where thing_id = p_thing and at < p_at)) a),
       streak as (select min(at) f from c where result = 3 and at > coalesce((select a from since), '-infinity'::timestamptz))
  select case when (select result from last) is distinct from 3 or (select f from streak) is null then 0
    else ((select max(at) from c) at time zone 'utc')::date - ((select f from streak) at time zone 'utc')::date + 1
  end
$$;

-- "new" unreachable: this check is unreachable and the one before was not, or a state row came in between
create or replace function public.aua_reach_numbers(p_from timestamptz, p_to timestamptz) returns jsonb language sql stable as $$
  with c as (
    select w.thing_id, w.at, w.result,
           lag(w.result) over (partition by w.thing_id order by w.at, w.id) prev,
           lag(w.at) over (partition by w.thing_id order by w.at, w.id) prev_at
      from public.wind_check w where w.at < p_to
  ), win as (
    select c.*, (c.result = 3 and (c.prev is distinct from 3 or exists (
              select 1 from public.thing_state s where s.thing_id = c.thing_id and s.at > c.prev_at and s.at <= c.at))) as first_down
      from c where at >= p_from and not public.aua_thing_gone(thing_id, p_to)
  )
  select jsonb_build_object(
    'checked',          (select count(*) from win),
    'passed',           (select count(*) from win where result = 0),
    'changed',          (select count(*) from win where result in (1, 2)),
    'unreachable',      (select count(*) from win where result = 3),
    'unreachable_new',  (select count(*) from win where first_down),
    'unreachable_cont', (select count(distinct thing_id) from win where result = 3 and not first_down),
    'unreachable_days', coalesce((select max(public.aua_unreach_days(thing_id, p_to)) from win where result = 3 and not first_down), 0),
    'gone_new',         (select count(*) from public.thing_state where state = 1 and at >= p_from and at < p_to),
    'back_new',         (select count(*) from public.thing_state where state = 0 and at >= p_from and at < p_to),
    'reused_new',       (select count(*) from public.thing_state where state = 2 and at >= p_from and at < p_to),
    'gone_days',        coalesce(public.aua_knob('gone_days'), 7))
$$;

revoke execute on function public.aua_use_reuse() from public, anon, authenticated;
