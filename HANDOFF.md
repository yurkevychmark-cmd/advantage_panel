# ADvantage — Handoff: фінанси + фінансовий портал + доступи

> Пакет для перенесення контексту в новий чат. Зріз: **2026-09-10**.

## 0. Хто і що
- Замовник: **Stepan** (stepan@advantage-agency.co) — співзасновник ADvantage.
- Засновники (в моделі оплат): **Marko + Stepan**, 50/50.
- Розробник/репозиторії під акаунтом **Marko** (GitHub `yurkevychmark-cmd`, git user `Marko7666`).

## 1. Два окремі проєкти на машині

| Проєкт | Локальний шлях | Git remote | Що це |
|---|---|---|---|
| **Finance portal** | `Finance portal/v10/index.html` | `github.com/yurkevychmark-cmd/advantage_panel` | Однофайловий React-додаток бухобліку агенції (цей документ здебільшого про нього) |
| **ADvantage BizDev** | `ADvatnage BizDev/` | `github.com/yurkevychmark-cmd/ADvatnage-BizDev` | Окремий Astro/Tailwind/TS-проєкт (BizDev/CRM, Reports, пропозали). Має свій `supabase/migrations`. |

## 2. Фінансовий портал — реалізація

- **Стек:** один файл `index.html`, React 18 через CDN, **без збірки** — JSX компілюється в браузері через `@babel/standalone`. Стилі інлайн. Темна тема.
- **CDN (закріплені):** `react@18`, `react-dom@18`, **`@babel/standalone@7`** (критично: v8 генерує ES-модулі й ламає додаток — не знімати пін), `@supabase/supabase-js@2`.
- **Хостинг:** **Vercel → https://advantage-panel.vercel.app/**. Деплой автоматичний: `git push origin main` у `advantage_panel` → Vercel сам оновлює сайт (~1 хв).
- **Розділи (нав):** `dashboard`, `operations` (Transactions), `team`, `accounts`, `journal`, `settings`, `mechanics`.

## 3. Фінансова модель агенції (зашита в коді)

**Рівняння грошей на кожну угоду:**
```
payment (надходження від клієнта) = costTax (комісії/kickbacks) + agencyRev (маржа агенції, «REV»/budget) + Σ workerPay (усі виплати, включно із засновниками)
```
- **`AGENCY_PCT = 0.18`** — дефолтна ставка agency fee. Рахується від **чистого**: `net = payment − costTax`; під коміркою Agency REV показується **живий %** від фактично вписаного значення (не статичні 18%).
- **`FOUNDER_FLOOR = 1500`** — місячний мінімум на кожного засновника; спліт **50/50** Marko+Stepan.
- **Reserve/Runway:** `reserve = Σ agencyRev − expenses`, переноситься помісячно (`carryover`). Runway у місяцях відносно floor.
- **Accrued vs Paid:** accrued = нараховано незалежно від чекбоксу; paid = стоїть галочка «оплачено».
- Кнопка **50/50** на рядку добалансовує залишок угоди на засновників, зберігаючи рівняння грошей.
- Помісячна звірка рахунків (**reconciliation**): «system balance» vs «real balance», з історією; verified budget = сума останніх звірених реальних балансів.

## 4. Дані та збереження

- **Supabase** (Auth + Postgres). Таблиці:
  - `global_settings` (рядок `id=1`): `workers`, `accounts`, `products` — спільні на всі місяці.
  - `monthly_data`: `month_key` (`YYYY-M`, місяць 0-індексований) → `data{ transactions, expenses, transfers, carryover }`.
- **Auth:** `supabase.auth.signInWithPassword` — паролі на боці Supabase, не в коді. Доступ мали лише Stepan і CEO.
- **Автозбереження:** debounce 1.5с; `hasLoadedRef` блокує збереження до завершення завантаження (щоб порожній стан не затер БД).
- **localStorage-бекапи** (захист від втрати даних): `adv_products`, `adv_accounts`, `adv_workers`, `adv_reconciliations`, `adv_action_log`, `salary_notify_workers`. На завантаженні дані **мерджаться** (перемагає версія з більшою кількістю записів), reconciliations бекапляться миттєво.

## 5. ⚠️ КРИТИЧНИЙ поточний стан — портал офлайн

Діагностовано: **бекенд Supabase-проєкт `tfzznkimnwimoqxwmyrp` більше не існує** — домен не резолвиться (`NXDOMAIN` через локальний, Google 8.8.8.8 і Cloudflare 1.1.1.1). Через це **неможливо залогінитись** (будь-яка помилка показує «Invalid email or password») і **дані недоступні**.
- Найімовірніша причина: free-tier проєкт **призупинили за неактивність** (збіглося з відпусткою) і згодом зняли.
- Проєкт **не належить** до Supabase-акаунта, підключеного через MCP (там лише `A-plat-crm`, `course-blackAffiliate[INACTIVE]`) — портал живе під **іншим Supabase-логіном (ймовірно CEO)**.
- **Що робити:** зайти в той Supabase Dashboard → якщо проєкт `Paused`, натиснути **Restore** (поверне DNS+дані+логін). Якщо видалено безповоротно — створити новий проєкт, оновити `supabaseUrl`+`supabaseKey` (рядки 20-21 в `index.html`), заново завести користувачів і таблиці; дані відновлювати з localStorage браузера, де працювали востаннє.

## 6. Доступи для редагування проєкту

- **Код:** локально `Finance portal/v10/index.html`; правки → `git commit` → `git push origin main` (repo `advantage_panel`) → Vercel автодеплой.
- **Ключ Supabase** у коді — **publishable/anon** (`sb_publishable_…`), не секретний; безпечно жити в клієнті.
- **Dev Standard:** `Finance portal/CLAUDE.md` (v1.4, канон — нода `guide-dev-standard`). Ключове: **П1** доводь до кінця й перевіряй сам; **П2** не ламай робоче, дані не зникають ніколи; **П3** лікуй причину; **A1** точний скоуп; **A4** коміть і пуш кожну завершену зміну (автодеплой).

## 7. Що потрібно новому чату, щоб бути продуктивним
1. Доступ до Supabase Dashboard власника проєкту (перевірити/Restore `tfzznkimnwimoqxwmyrp` **або** видати новий проєкт + креденшли).
2. Підтвердження, який репозиторій у фокусі (`advantage_panel` для порталу).
3. Прочитати `CLAUDE.md` (Dev Standard) перед задачею.

---

## Додаток A — Історія останніх змін порталу (git)
- `Agency REV` показує живий % від net (`payment − cost/tax`) замість статичних 18%.
- Дефолт на поточний місяць/рік при завантаженні; localStorage-бекап для workers.
- Блюр зарплат працівників за замовчуванням + тумблер show/hide (авто-приховування через 10 хв).
- Пін `@babel/standalone@7` (фікс поломки від Babel 8).
- Захист reconciliation-даних від втрати при релоаді/деплої.
- Bell-панель system checks, verified budget у KPI, пошук клієнтів.
