-- Pull a Card: one table holds every game document, keyed by table name (room).
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

create table if not exists public.docs (
  room       text        not null,
  coll       text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (room, coll, id)
);

alter table public.docs enable row level security;

-- Anyone with the app and a table name can play at that table.
-- The table name works like a shared password, so pick one that isn't guessable.
drop policy if exists "players read"   on public.docs;
drop policy if exists "players write"  on public.docs;
drop policy if exists "players update" on public.docs;
drop policy if exists "players delete" on public.docs;
create policy "players read"   on public.docs for select using (true);
create policy "players write"  on public.docs for insert with check (true);
create policy "players update" on public.docs for update using (true) with check (true);
create policy "players delete" on public.docs for delete using (true);

-- Live updates between phones.
alter table public.docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
