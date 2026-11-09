-- Proposal numbers start at 10001.
-- Run once in Supabase > SQL Editor. Safe to run again: it never goes back below a number already used.
-- Drafts that already have numbers (1001, 1002...) keep them. New drafts get 10001, 10002, and so on.

-- 1) A counter that starts at 10001
create sequence if not exists public.proposal_number_seq start 10001;

-- Continue after the highest number already used or already handed out. Never moves backwards, even if run again.
select setval('public.proposal_number_seq',
  greatest(
    10000,
    (select case when is_called then last_value else last_value - 1 end from public.proposal_number_seq),
    coalesce((select max((data->>'num')::bigint) from public.drafts where (data->>'num') ~ '^[0-9]{1,15}$'), 0)
  ),
  true);

-- 2) The app asks this function for the next number when a draft is saved for the first time
drop function if exists public.next_proposal_number();
create function public.next_proposal_number()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_team() then
    raise exception 'not_on_team';
  end if;
  return nextval('public.proposal_number_seq');
end;
$$;

revoke all on function public.next_proposal_number() from public, anon;
grant execute on function public.next_proposal_number() to authenticated;

-- 3) Check: shows the next number that will be handed out
select last_value + 1 as next_proposal_number from public.proposal_number_seq;
