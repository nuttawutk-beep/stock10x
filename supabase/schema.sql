-- Stock10x — Supabase schema
-- Run this in the Supabase SQL Editor to set up the database

create table if not exists public.stocks (
  id                  bigserial primary key,
  symbol              text not null unique,
  name                text not null,
  current_price       numeric(12, 2) not null,
  price_target_2030   numeric(12, 2),
  analyst_price_target numeric(12, 2),
  action              text check (action in ('Strong Buy', 'Buy', 'Hold', 'Sell')),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- Row-level security (public read, service-role write)
alter table public.stocks enable row level security;

create policy "Public read" on public.stocks
  for select using (true);

-- Seed data (matches the dashboard)
insert into public.stocks (symbol, name, current_price, price_target_2030, analyst_price_target, action) values
  ('NVDA', 'NVIDIA Corporation',     875,  2200, 1050, 'Strong Buy'),
  ('TSLA', 'Tesla Inc.',             182,  450,  220,  'Buy'),
  ('META', 'Meta Platforms Inc.',    525,  900,  610,  'Buy'),
  ('AMZN', 'Amazon.com Inc.',        182,  350,  215,  'Strong Buy'),
  ('MSFT', 'Microsoft Corporation',  415,  600,  470,  'Buy'),
  ('AAPL', 'Apple Inc.',             196,  280,  210,  'Hold')
on conflict (symbol) do update set
  current_price       = excluded.current_price,
  price_target_2030   = excluded.price_target_2030,
  analyst_price_target = excluded.analyst_price_target,
  action              = excluded.action,
  updated_at          = now();
