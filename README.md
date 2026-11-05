# Dousefire Proposal Builder

Fire sprinkler proposal builder: questions, scope review, live proposal with letterhead,
PDF / Word / CSV downloads, shared drafts with search, proposal numbers from 1001, review and approval,
ClickUp and QuickBooks connections, Send feedback, and an admin-editable logic map.

## Files
- `index.html`: the app. The Supabase URL and anon key are near the top of the script.
- `supabase/functions/clickup/index.ts`: Edge Function `clickup`. Finds Open and In Progress jobs in the ClickUp Proposals list, reads their fields, saves proposal files to the job.
- `supabase/functions/feedback/index.ts`: Edge Function `feedback`. Saves feedback and emails it to the office.
- `supabase/feedback.sql`: run once in the Supabase SQL Editor. Creates the `feedback` table.
- The `qbo` Edge Function and the original `setup.sql` live in Supabase only. Add them here as a backup.

## Supabase secrets (Edge Functions > Secrets)
- `CLICKUP_TOKEN`, `CLICKUP_LIST_ID`: ClickUp connection.
- `RESEND_API_KEY`: from resend.com, for feedback emails.
- `FEEDBACK_TO`: where feedback goes, e.g. `office@pivotyes.com`.
- `FEEDBACK_FROM` (optional): sender once a domain is verified in Resend.

## Managing the team
Admins use the Team tab in the app: add people by email, set roles (Admin, Manager, Estimator) and who reviews their drafts.
New people then open the app, click Sign in, then "First time here? Create your password".
