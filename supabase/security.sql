-- Dousefire Proposal Builder: role rules enforced by the database, not just the app.
-- Run once in Supabase > SQL Editor. Safe to run again.
-- What it does:
--   * Team emails are matched exactly (no look-alike emails), and stored lower case.
--   * Only managers and admins can approve a draft or send it back for changes.
--   * "Created by", "Updated by" and "Approved by" are set by the database from who is signed in, so they can't be faked.
--   * Only managers and admins can delete drafts.
--   * Only admins can change the team list, the Logic map, and the ClickUp / QuickBooks settings.
-- If any step shows an error, stop and send the message to Claude.

-- 0) Safety check: the rules below expect drafts.data to be jsonb
do $$
begin
  if (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'drafts' and column_name = 'data') <> 'jsonb' then
    raise exception 'drafts.data is not jsonb. Nothing was changed. Send this message to Claude.';
  end if;
end $$;

-- 1) Team emails: stored lower case, matched exactly
create or replace function public.team_lower_email() returns trigger language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  if new.review_by is not null then new.review_by := nullif(lower(trim(new.review_by)), ''); end if;
  return new;
end $$;
drop trigger if exists team_lower_email on public.team;
create trigger team_lower_email before insert or update on public.team for each row execute function public.team_lower_email();
update public.team set email = lower(trim(email)) where email <> lower(trim(email));
update public.team set review_by = lower(trim(review_by)) where review_by is not null and review_by <> lower(trim(review_by));

-- The signed-in person's role: admin, manager or estimator (null if not on the team)
create or replace function public.team_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(t.role, ''), case when t.is_admin then 'admin' else 'estimator' end)
  from public.team t
  where t.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1
$$;
revoke all on function public.team_role() from public, anon;
grant execute on function public.team_role() to authenticated;

-- The checks the app and the server functions already call, now using the exact match above
create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = public as $$ select public.team_role() is not null $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select public.team_role() = 'admin' $$;
create or replace function public.can_delete() returns boolean
language sql stable security definer set search_path = public as $$ select public.team_role() in ('admin', 'manager') $$;

-- 2) Drafts: who did what is recorded by the database; only managers and admins approve or send back
create or replace function public.drafts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  me text := lower(coalesce(auth.jwt() ->> 'email', ''));
  r text;
  new_status text := coalesce(new.data ->> 'status', 'draft');
  old_status text := case when tg_op = 'UPDATE' then coalesce(old.data ->> 'status', 'draft') else 'draft' end;
begin
  -- Direct database work (SQL Editor, Table Editor) and server functions are not limited
  if auth.jwt() is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role' then return new; end if;
  r := public.team_role();
  if r is null then raise exception 'not_on_team'; end if;

  if tg_op = 'INSERT' then
    new.data := jsonb_set(new.data, '{createdBy}', to_jsonb(me));
  else
    new.data := jsonb_set(new.data, '{createdBy}', coalesce(old.data -> 'createdBy', to_jsonb(me)));
  end if;
  new.data := jsonb_set(new.data, '{updatedBy}', to_jsonb(me));

  if new_status in ('approved', 'changes') and new_status is distinct from old_status and r not in ('admin', 'manager') then
    raise exception 'Only managers and admins can approve a draft or send it back for changes.';
  end if;
  if new_status = 'approved' then
    new.data := jsonb_set(new.data, '{approvedBy}',
      case when old_status = 'approved' then coalesce(old.data -> 'approvedBy', to_jsonb(me)) else to_jsonb(me) end);
  else
    new.data := jsonb_set(new.data, '{approvedBy}', to_jsonb(''::text));
  end if;
  return new;
end $$;
drop trigger if exists drafts_guard on public.drafts;
create trigger drafts_guard before insert or update on public.drafts for each row execute function public.drafts_guard();

-- 3) Extra limits on top of the rules you already have (these can only take access away, never add it)
drop policy if exists "managers delete drafts" on public.drafts;
create policy "managers delete drafts" on public.drafts as restrictive for delete to public using (public.team_role() in ('admin', 'manager'));

drop policy if exists "admins add settings" on public.settings;
drop policy if exists "admins change settings" on public.settings;
drop policy if exists "admins delete settings" on public.settings;
create policy "admins add settings" on public.settings as restrictive for insert to public with check (public.team_role() = 'admin');
create policy "admins change settings" on public.settings as restrictive for update to public using (public.team_role() = 'admin') with check (public.team_role() = 'admin');
create policy "admins delete settings" on public.settings as restrictive for delete to public using (public.team_role() = 'admin');

drop policy if exists "admins add team" on public.team;
drop policy if exists "admins change team" on public.team;
drop policy if exists "admins delete team" on public.team;
create policy "admins add team" on public.team as restrictive for insert to public with check (public.team_role() = 'admin');
create policy "admins change team" on public.team as restrictive for update to public using (public.team_role() = 'admin') with check (public.team_role() = 'admin');
create policy "admins delete team" on public.team as restrictive for delete to public using (public.team_role() = 'admin');

-- 4) Check: every table should show rls_on = true. If any says false, tell Claude before going further.
select c.relname as table_name, c.relrowsecurity as rls_on
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('drafts', 'settings', 'team', 'feedback')
order by 1;
