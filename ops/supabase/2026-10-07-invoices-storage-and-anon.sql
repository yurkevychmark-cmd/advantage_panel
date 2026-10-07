-- Фінпортал · 07.10.2026 · таск 1b538f22 (P2-8, P2-10). Запускає Марко в Supabase → SQL Editor → Run.
-- Повторний запуск безпечний (усе з "if not exists" / "on conflict").

-- 1) Приватне сховище для файлів інвойсів: без публічних посилань, до 20 МБ на файл.
insert into storage.buckets (id, name, public, file_size_limit)
values ('invoices', 'invoices', false, 20971520)
on conflict (id) do nothing;

-- 2) Файли інвойсів бачать, завантажують і замінюють лише залогінені користувачі порталу; анонімний ключ — нічого.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'invoices_select_authenticated') then
    create policy invoices_select_authenticated on storage.objects for select to authenticated using (bucket_id = 'invoices');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'invoices_insert_authenticated') then
    create policy invoices_insert_authenticated on storage.objects for insert to authenticated with check (bucket_id = 'invoices');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'invoices_update_authenticated') then
    create policy invoices_update_authenticated on storage.objects for update to authenticated using (bucket_id = 'invoices') with check (bucket_id = 'invoices');
  end if;
end $$;

-- 3) Другий рівень захисту таблиць: анонімна роль утрачає всі права на таблиці порталу
--    (зараз її зупиняє лише RLS; портал працює тільки під залогіненим користувачем, тож нічого не зміниться).
revoke all on table public.global_settings, public.monthly_data from anon;

-- Перевірка: має повернути бакет invoices (public = false) і 3 політики.
select id, public, file_size_limit from storage.buckets where id = 'invoices';
select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'invoices_%';
