-- Схема бази фінпорталу (Supabase project tfzznkimnwimoqxwmyrp, PostgreSQL 17.6), знята 07.10.2026 запитом до
-- information_schema / pg_policies. Використовується навчальним відновленням (restore-drill.sh) і для повного
-- відновлення в новий проєкт. Дані — у бекапі (finportal-dump.mjs), тут лише структура.

create table if not exists public.global_settings (
  id       integer primary key,
  workers  jsonb,
  accounts jsonb,
  products jsonb default '[]'::jsonb
);

create table if not exists public.monthly_data (
  month_key text primary key,   -- "YYYY-M", місяць 0-індексований
  data      jsonb
);

-- Доступ (лише в Supabase, де є ролі anon / authenticated; у тимчасовій базі навчального відновлення не потрібен):
--   alter table public.global_settings enable row level security;
--   alter table public.monthly_data    enable row level security;
--   create policy auth_all_settings  on public.global_settings for all    to authenticated using (true) with check (true);
--   create policy auth_read_settings on public.global_settings for select to authenticated using (true);
--   create policy auth_all_monthly   on public.monthly_data    for all    to authenticated using (true) with check (true);
--   create policy auth_read_monthly  on public.monthly_data    for select to authenticated using (true);
--   Реєстрація нових користувачів у проєкті вимкнена: authenticated = лише користувачі, додані вручну.
