-- Stock10x — Theses table
-- Run in Supabase SQL Editor (or via CLI) after schema.sql

create table if not exists public.theses (
  id           bigserial primary key,
  symbol       text not null unique,
  generated_at timestamptz default now(),
  updated_at   timestamptz default now(),
  data         jsonb not null
);

alter table public.theses enable row level security;

create policy "Public read" on public.theses
  for select using (true);

create policy "Public write" on public.theses
  for all using (true);

-- Auto-update updated_at on upsert
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger theses_updated_at
  before update on public.theses
  for each row execute procedure public.set_updated_at();
