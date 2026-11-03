-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
create table if not exists public.docs (
  path text primary key,
  collection text not null,
  data jsonb not null,
  owner uuid not null default auth.uid(),
  updated_at timestamptz not null default now()
);
create index if not exists docs_collection_idx on public.docs (collection);
alter table public.docs enable row level security;

-- Everyone can read clubs, members and leagues.
drop policy if exists "docs read" on public.docs;
create policy "docs read" on public.docs for select using (true);

-- People can only create or change their own club, sign-up and league
-- (the document id is their own user id).
drop policy if exists "docs insert own" on public.docs;
create policy "docs insert own" on public.docs for insert to authenticated
  with check (owner = auth.uid()
    and split_part(path, '/', 2) = auth.uid()::text
    and collection in ('clubs', 'members', 'leagues')
    and collection = split_part(path, '/', 1)
    and pg_column_size(data) < 200000);
drop policy if exists "docs update own" on public.docs;
create policy "docs update own" on public.docs for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid()
    and split_part(path, '/', 2) = auth.uid()::text
    and pg_column_size(data) < 200000);

-- Live updates for clubs and leagues.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
