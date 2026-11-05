-- Run once in Supabase > SQL Editor. Creates the table that keeps every piece of feedback.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text,
  name text,
  kind text,
  message text not null,
  context jsonb,
  user_agent text,
  status text not null default 'new'
);
alter table public.feedback enable row level security;

-- Anyone on the team can send feedback, only as themselves
drop policy if exists "team can send feedback" on public.feedback;
create policy "team can send feedback" on public.feedback for insert to authenticated
  with check (public.is_team() and lower(email) = lower(auth.jwt() ->> 'email'));

-- Only admins can read it in the app or API (you can always see it in Table Editor)
drop policy if exists "admins read feedback" on public.feedback;
create policy "admins read feedback" on public.feedback for select to authenticated
  using (exists (select 1 from public.team t where lower(t.email) = lower(auth.jwt() ->> 'email') and (t.role = 'admin' or t.is_admin)));
