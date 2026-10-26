# Dousefire Proposal Builder

Fire sprinkler proposal builder: questions, scope review, live proposal with letterhead,
PDF / Word / CSV downloads, shared drafts, proposal numbers from 1001, and an admin-editable logic map.

## Files
- `index.html`: the app. Paste your Supabase URL and anon key near the top of the script.
- `setup.sql`: run once in Supabase to create the tables and permissions.

## Managing the team (Supabase > Table Editor > team)
- Add a row with the person's email to give them access.
- Set `is_admin` to true for anyone who should edit the logic map.
- Delete the row to remove access.
