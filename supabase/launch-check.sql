-- Dousefire Proposal Builder: launch check. READ ONLY - it changes nothing.
-- Run in Supabase > SQL Editor, then send Claude a screenshot (or copy) of the result table.
-- It lists every access rule on the app's tables, who can call the app's database functions, and whether row security is on.

select * from (
  -- 1) Row security on each table (should all say on)
  select 1 as sort, 'row security' as check_type, c.relname as item,
         case when c.relrowsecurity then 'on' else 'OFF' end as detail
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'

  union all
  -- 2) Every access rule (policy) on public tables: who it applies to and what it checks
  select 2, 'rule: ' || p.tablename || ' / ' || p.cmd || ' / ' || case when p.permissive = 'PERMISSIVE' then 'allows' else 'limits' end,
         p.policyname,
         'roles=' || array_to_string(p.roles, ',') || ' | using: ' || coalesce(p.qual, '-') || ' | check: ' || coalesce(p.with_check, '-')
  from pg_policies p where p.schemaname = 'public'

  union all
  -- 3) What signed-out visitors (anon) may do directly on each table
  select 3, 'anon can', t.table_name, string_agg(t.privilege_type, ', ' order by t.privilege_type)
  from information_schema.role_table_grants t
  where t.table_schema = 'public' and t.grantee = 'anon'
  group by t.table_name

  union all
  -- 4) App database functions: who may call them
  select 4, 'function', r.routine_name,
         'anon=' || has_function_privilege('anon', p.oid, 'execute')::text || ' authenticated=' || has_function_privilege('authenticated', p.oid, 'execute')::text
         || ' security_definer=' || p.prosecdef::text
  from information_schema.routines r
  join pg_proc p on p.proname = r.routine_name
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = r.routine_schema
  where r.routine_schema = 'public'
    and r.routine_name in ('is_team', 'is_admin', 'can_delete', 'team_role', 'next_proposal_number', 'drafts_guard', 'team_lower_email')

  union all
  -- 5) Triggers on the app's tables
  select 5, 'trigger', tg.tgrelid::regclass::text, tg.tgname
  from pg_trigger tg where not tg.tgisinternal and tg.tgrelid::regclass::text in ('drafts', 'team', 'settings', 'public.drafts', 'public.team', 'public.settings')

  union all
  -- 6) Sign-up settings that matter for launch
  select 6, 'auth', 'team rows without a sign-in yet',
         (select count(*)::text from public.team t where not exists (select 1 from auth.users u where lower(u.email) = t.email))
  union all
  select 6, 'auth', 'sign-ins not on the team', (select count(*)::text from auth.users u where not exists (select 1 from public.team t where t.email = lower(u.email)))
  union all
  select 6, 'auth', 'sign-ins with unconfirmed email', (select count(*)::text from auth.users where email_confirmed_at is null)
) x
order by sort, check_type, item;
