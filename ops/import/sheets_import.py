#!/usr/bin/env python3
"""Turn the agency's old Google-Sheets reports (xlsx exports, 2024 and 2025) into finance-portal month records.

    python3 sheets_import.py <2024.xlsx> <2025.xlsx> --roster <portal-full-backup.json> --out <payload.json>

Reads the workbooks only; nothing here touches the database. The payload goes to apply_import.mjs, which writes it.
Besides the records, the payload carries a reconciliation per month (printed by reconcile.py): every total the SHEET
ITSELF shows (header, side summary, "total" row) is traced back to its formula, the formula's SUM ranges are expanded,
and the difference to what the portal will show is decomposed into (a) amounts typed as text, which SUM skips, and
(b) imported cells the sheet's formula range does not reach. A month reconciles when nothing else is left over.

Tabs read (anything else — Card, Services and pass, Our payers, Team info… — is never opened):
  2024  AD_01.01…AD_01.05 (= Revenue Jan–May) · Revenue - Jun…Dec · Cost 01.01…01.05 · Cost - Jun…Dec
        ("Revenue - Jan" in the 2024 file is a draft that mixes November and December 2024 deals — skipped)
  2025  Revenue - Jan…DEC · Cost - Jan…NOV
Revenue layouts, recognised by their header labels:
  A (2025)          Clients | Our service | Платіжка | Payment | Data | Cost/tax | Agency tax/REV | per person: amount, paid
  B (2024 Jul–Dec)  Clients | Our service | Payment | Data | Cost/tax | Agency tax | per person: amount
  C (2024 Jan–Jun)  Проекти | Cума | Дата | Кости | Бюджет агенції | per person (Ukrainian names): amount
                    — the deal table ends at the "Потенційні клієнти" (prospects) section
Cost tabs: expense rows × day-of-month columns 1..31; every filled day cell = one payment on that day.
The table ends at its "total" row (first row without a name); anything below it is a side note and is skipped.

Decisions (all listed in the payload's `flags` for the report):
  * Amounts typed as text ("507$", "$200") are real money when the row balances with them — imported, flagged.
  * The sheets also list planned deals. A deal counts as paid only if somebody's pay came out of it — in 2025 with the
    ✓ "paid" box, in 2024 (no ✓ column) any pay at all; otherwise it is imported as pending (planned / moved to a later
    month), outside turnover and REV. Rule from Марко, 08.10.2026. Rows with no payment (cost-only) stay as they are.
  * Deals are NOT linked to portal accounts (the account named in the sheet goes to `sheetAccount` and the comment):
    portal account balances and limits are computed over all months, and the import must not move today's numbers.
  * Card numbers in Cost tabs are not carried over; the payer (Steve/Marko…) goes to `sheetPayer`.
  * Ids are deterministic (file/tab/row/column) and every record has `importedFrom`, so re-running yields the same data.
"""
import argparse, calendar, datetime, functools, hashlib, json, re, unicodedata, warnings
import openpyxl
from openpyxl.utils import column_index_from_string, get_column_letter

warnings.filterwarnings('ignore')
MONTHS = {m: i for i, m in enumerate(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}
UA_NAMES = {'степан': 'Stepan', 'марко': 'Marko', 'павло': 'Pavlo', 'орест': 'Orest', 'святослав': 'Svyatoslav',
            'сергій': 'Sergey', 'нік': 'Nick', 'андрій': 'Andrii', 'анна': 'Anna', 'ростик': 'Rostyk', 'лукаш': 'Lukash'}
LATIN_LOOKALIKE = str.maketrans('CcAaEeOoPpXxIiKkMHTB', 'СсАаЕеОоРрХхІіКкМНТВ')
# Sheet name → portal worker name. "Andrii" in the 2024–25 sheets is the media buyer; the portal's "Andrii" (Dev, fixed
# rate since July 2026) is a later hire — so the sheet one becomes his own departed member (flagged in the report).
RENAME = {'Valwntyn': 'Valentyn', 'Andrii': 'Andrii (Media Buyer)'}
METHOD = re.compile(r'(usdt|usd[cс]|pln?|cash|binance|wise|revolut|paypal|stripe)', re.I)
FLAGS = []


def hid(*parts):
    return 'imp-' + hashlib.sha1('|'.join(str(p) for p in parts).encode()).hexdigest()[:12]


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def txt(c):
    return str(c).strip() if c is not None else ''


def money(v):
    """→ (value, kind): 'num' (a number cell — what the sheet's SUMs count), 'text' ("507$" — money SUM skips),
    'foreign' (PLN/UAH/EUR text — not converted), or (None, None) for empty / '-' / '???'."""
    if is_num(v):
        return float(v), 'num'
    s = txt(v).replace('\xa0', '').replace(' ', '')
    if not s or set(s) <= set('-—?'):
        return None, None
    if re.search(r'pln|zł|uah|грн|eur|€', s, re.I):
        return None, 'foreign'
    m = re.fullmatch(r'(-?)\$?(-?\d+(?:[.,]\d+)?)\$?', s)
    if m:
        return float(m.group(2).replace(',', '.')) * (-1 if m.group(1) else 1), 'text'
    return None, None


def fmt_date(v, year, mi):
    if isinstance(v, datetime.datetime):
        return v.strftime('%d.%m.%Y')
    m = re.fullmatch(r'\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s*', txt(v))
    if m and 1 <= int(m.group(2)) <= 12:
        d, mo = int(m.group(1)), int(m.group(2))
        y = int(m.group(3)) if m.group(3) else min((year - 1, year, year + 1), key=lambda yy: abs(yy * 12 + mo - 1 - (year * 12 + mi)))
        return f'{d:02d}.{mo:02d}.{y + 2000 if y < 100 else y}'
    return ''


def norm_name(s):
    s = unicodedata.normalize('NFC', txt(s))
    if re.search('[а-яіїєґ]', s, re.I):
        s = s.translate(LATIN_LOOKALIKE)                     # "Cергій" typed with a Latin C
        low = s.lower()
        s = next((en for ua, en in UA_NAMES.items() if low == ua or (len(low) >= 5 and ua.startswith(low))), s)  # "Святосла"
    return RENAME.get(s, s)


def rows_of(ws):
    return [list(r) + [None] * 80 for r in ws.iter_rows(values_only=True)]


def find_row(R, pred, limit=12):
    return next((i for i, r in enumerate(R[:limit]) if pred(r)), None)


# ---------------------------------------------------------------- the sheet's own formulas
SUM_RE = re.compile(r'([+-]?)\s*SUM\(\s*\$?([A-Z]+)\$?(\d+)\s*:\s*\$?([A-Z]+)\$?(\d+)\s*\)', re.I)


def make_cover(F):
    """covered(row, col) → set of (row, col) leaf cells a total cell adds up (SUM ranges expanded, nested SUMs followed)."""
    @functools.lru_cache(maxsize=None)
    def covered(row, col, depth=0):
        v = F.cell(row, col).value
        terms = SUM_RE.findall(v) if isinstance(v, str) and v.startswith('=') else []
        if not terms or depth > 3:
            return frozenset({(row, col)})
        out = set()
        for sign, c1, r1, c2, r2 in terms:
            if sign == '-':
                continue
            for rr in range(int(r1), int(r2) + 1):
                for cc in range(column_index_from_string(c1.upper()), column_index_from_string(c2.upper()) + 1):
                    out |= covered(rr, cc, depth + 1)
        return frozenset(out)
    return covered


def formula(F, row, col):
    v = F.cell(row, col).value
    return v if isinstance(v, str) and v.startswith('=') else None


def trace(F, field, shown_cells, cells, portal_value, key, tab):
    """Reconcile one total: sheet shows X (cells) → portal shows Y; Y − X must be fully explained."""
    if not shown_cells:
        return {'field': field, 'shown': None, 'portal': round(portal_value, 2), 'ok': None, 'note': 'the sheet shows no total for this'}
    cover = make_cover(F)
    covered = set().union(*(cover(r, c) for r, c, _ in shown_cells))
    shown = sum(v for _, _, v in shown_cells)
    mine = [c for c in cells if c['field'] == field]
    outside = [c for c in mine if c['imported'] and c['kind'] == 'num' and (c['row'], c['col']) not in covered]
    not_imp = [c for c in mine if not c['imported'] and c['kind'] == 'num' and (c['row'], c['col']) in covered]
    text = [c for c in mine if c['imported'] and c['kind'] == 'text']
    expected = shown + sum(c['amount'] for c in outside) - sum(c['amount'] for c in not_imp) + sum(c['amount'] for c in text)
    where = ', '.join(f'{get_column_letter(c)}{r} {formula(F, r, c) or ""}'.strip() for r, c, _ in shown_cells)
    brief = lambda L: [(f"{get_column_letter(c['col'])}{c['row']}", c['label'], c['amount']) for c in L]
    for c in outside:
        FLAGS.append(f"{key} {tab}: {field} total ({where}) does not reach {get_column_letter(c['col'])}{c['row']} "
                     f"\"{c['label']}\" {c['amount']:,.2f} — imported; the sheet's total is low by this amount")
    for c in not_imp:
        FLAGS.append(f"{key} {tab}: {field} total ({where}) includes {get_column_letter(c['col'])}{c['row']} "
                     f"\"{c['label']}\" {c['amount']:,.2f}, which is not in the portal total (pending / side note / prospects)")
    return {'field': field, 'shown': round(shown, 2), 'where': where, 'outsideRange': brief(outside), 'notImported': brief(not_imp),
            'textAmounts': brief(text), 'portal': round(portal_value, 2), 'ok': abs(expected - portal_value) < 0.01}


# ---------------------------------------------------------------- revenue tabs
def parse_revenue(R, F, year, mi, src, key):
    hi = find_row(R, lambda r: any(txt(c).lower().startswith(('clients', 'проекти')) for c in r))
    H = [txt(c).lower().rstrip(':') for c in R[hi]]
    col = lambda *names: next((j for j, h in enumerate(H) if any(h.startswith(n) for n in names)), None)
    c_client, c_service, c_acc = col('clients', 'проекти'), col('our service'), col('платіжка')
    c_pay, c_date, c_cost = col('payment', 'cума', 'сума'), col('data', 'дата'), col('cost', 'кости')
    c_rev = col('agency tax', 'agency rev', 'бюджет агенції')
    layout = 'A' if c_acc is not None else ('C' if c_service is None else 'B')
    first = max(c for c in (c_client, c_service, c_acc, c_pay, c_date, c_cost, c_rev) if c is not None) + 1
    # names: layout C in the header row itself; A/B in the row above with the most one-word names right of the fixed block
    one_word = lambda c: bool(re.fullmatch(r'[A-Za-zА-Яа-яІіЇїЄєҐґ]+', txt(c)))
    name_row = R[hi] if layout == 'C' else max(R[:hi], key=lambda r: sum(one_word(c) for c in r[first:first + 60]))
    people, prev = [], None
    for j in range(first, first + 60):
        n = txt(name_row[j])
        if not n or n == '-' or re.fullmatch(r'[\d.,\s$]+', n):
            continue
        if prev is not None and j - prev > 6:               # side tables further right
            break
        paid_col = j + 1 if any(isinstance(R[k][j + 1], bool) for k in range(hi + 1, min(len(R), hi + 40))) else None
        role = txt(R[hi - 1][j]) if hi >= 1 and not is_num(R[hi - 1][j]) else ''
        people.append({'name': norm_name(n), 'col': j, 'paid_col': paid_col, 'role': '' if norm_name(role) == norm_name(n) else role})
        prev = j

    deals, cells, skipped_empty, in_table = [], [], 0, True
    for i in range(hi + 1, len(R)):
        r = R[i]
        client = txt(r[c_client])
        if client.lower().startswith(('потенційні', 'potential')):
            in_table = False                                 # prospects, not deals
        if not client:
            continue
        notes, texts, row_cells = [], [], []

        def val(c, what, field):
            if c is None:
                return None, None
            v, kind = money(r[c])
            if v is not None:
                row_cells.append({'field': field, 'row': i + 1, 'col': c + 1, 'amount': v, 'kind': kind, 'label': client, 'imported': in_table})
            if kind == 'text':
                texts.append((what, v, txt(r[c])))
            if kind == 'foreign' and in_table:
                notes.append(f'{what} in the sheet: {txt(r[c])} (not USD, not converted)')
                FLAGS.append(f'{key} {src} row {i + 1} "{client}": {what} "{txt(r[c])}" is not in USD — kept in the comment, not converted')
            return v, kind

        pay, pay_k = val(c_pay, 'payment', 'turnover')
        cost, _ = val(c_cost, 'cost/tax', 'costs')
        rev, _ = val(c_rev, 'agency REV', 'revenue')
        wp = {}
        for p in people:
            amt, _ = val(p['col'], p['name'], 'pay:' + p['name'])
            if not amt:
                continue
            paid = bool(r[p['paid_col']]) if p['paid_col'] is not None and isinstance(r[p['paid_col']], bool) else layout != 'A'
            e = wp.setdefault(p['name'], {'amount': 0.0, 'paid': True, 'advance': 0, 'comment': ''})
            e['amount'] += amt
            e['paid'] = e['paid'] and paid
        cells.extend(row_cells)
        if not in_table:
            continue
        if not pay and not cost and not rev and not wp:
            skipped_empty += 1
            continue
        date = fmt_date(r[c_date], year, mi) if c_date is not None else ''
        status = 'received'
        if pay_k == 'text' and not wp and not rev and not date:
            status = 'pending'
            for c in row_cells:
                if c['field'] in ('turnover', 'revenue', 'costs'):
                    c['imported'] = False                    # pending deals are outside the portal's month totals
            FLAGS.append(f'{key} {src} row {i + 1} "{client}": payment "{txt(r[c_pay])}" typed as text, no date, nobody paid from it → imported as PENDING (expected, not confirmed)')
        elif pay and pay > 0 and not (any(e['paid'] for e in wp.values()) if layout == 'A' else wp):
            # Марко, 08.10: the sheets also list planned deals — a deal counts as paid only if somebody's pay came out
            # of it (2025: with the ✓; 2024 has no ✓ column, so: any pay at all). Otherwise planned / moved → pending.
            status = 'pending'
            for c in row_cells:
                if c['field'] in ('turnover', 'revenue', 'costs'):
                    c['imported'] = False
            FLAGS.append(f'{key} {src} row {i + 1} "{client}" ${pay:,.0f}: nobody was paid from it'
                         f'{" (no ✓)" if layout == "A" and wp else ""} → PENDING (planned, not confirmed as paid)')
        if status == 'received' and texts:
            FLAGS.append(f'{key} {src} row {i + 1} "{client}": ' + ', '.join(f'{w} "{raw}"' for w, _, raw in texts) +
                         ' typed as text — SUM skips it; imported as the amount')
        if texts:
            notes.append('in the sheet as text: ' + ', '.join(f'{w} “{raw}”' for w, _, raw in texts))
        account = txt(r[c_acc]) if c_acc is not None and txt(r[c_acc]).strip('?-') else ''
        if account:
            notes.insert(0, f'account in the sheet: {account}')
        deals.append({'id': hid(src, i, client), 'client': client, 'service': txt(r[c_service]) if c_service is not None else '',
                      'platforma': '', 'payment': pay or 0, 'date': date, 'costTax': cost or 0, 'agencyRev': rev or 0,
                      'comment': ' · '.join(notes), 'invoice': None, 'status': status,
                      'workerPay': {n: {**e, 'amount': round(e['amount'], 2)} for n, e in wp.items()},
                      'sheetAccount': account, 'importedFrom': src})

    # the cells holding the totals the sheet itself displays (1-based row, col, value)
    shown = {'turnover': [], 'revenue': []}
    for i, r in enumerate(R[:hi]):
        for j, c in enumerate(r):
            t = txt(c).rstrip(':').strip()
            if t == 'Agency Turnower' and is_num(r[j + 1]):
                shown['turnover'].append((i + 1, j + 2, float(r[j + 1])))
            if t == 'Agency Budget' and is_num(r[j + 1]) and '-' not in (formula(F, i + 1, j + 2) or '').lstrip('='):
                shown['revenue'].append((i + 1, j + 2, float(r[j + 1])))
            if t.startswith('Total Revenue Per Person'):
                for p in people:
                    if is_num(r[p['col']]):
                        shown.setdefault('pay:' + p['name'], []).append((i + 1, p['col'] + 1, float(r[p['col']])))
    if not shown['revenue'] and c_rev is not None:          # e.g. DEC 2025: "Agency Budget" = REV − costs; use the REV column total
        shown['revenue'] = [(i + 1, c_rev + 1, float(R[i][c_rev])) for i in range(hi)
                            if is_num(R[i][c_rev]) and SUM_RE.search(formula(F, i + 1, c_rev + 1) or '')][:1]
    if layout == 'C' and hi >= 1 and people:               # side summary: label in the row above, value in the header row
        for j in range(people[-1]['col'] + 2, people[-1]['col'] + 30):
            lab, (v, _) = txt(R[hi - 1][j]), money(R[hi][j])
            if not lab or v is None:
                continue
            f = 'turnover' if lab.lower().startswith('оборот') else 'revenue' if lab.lower().startswith('бюджет') else 'pay:' + norm_name(lab)
            shown.setdefault(f, []).append((hi + 1, j + 1, v))
    return layout, deals, cells, shown, skipped_empty, {p['name']: p['role'] for p in people if p['role']}


# ---------------------------------------------------------------- cost tabs
def parse_cost(R, year, mi, src, key):
    is_day = lambda c: (is_num(c) and c == int(c) and 1 <= c <= 31) or txt(c) in [str(d) for d in range(1, 32)]
    hi = find_row(R, lambda r: sum(1 for c in r if is_day(c)) >= 25, limit=15)
    day_col = {}
    for j, c in enumerate(R[hi]):
        if is_day(c) and int(float(txt(c))) not in day_col:
            day_col[int(float(txt(c)))] = j
    d1, total_col = day_col[1], max(day_col.values()) + 1
    hdr = [txt(c).lower() for c in R[hi][:d1]]
    card_col = next((j for j, h in enumerate(hdr) if h in ('card', 'картка')), None)
    # 2025 Mar+: category | name | payer | Card ;  2024 – Feb 2025: name | card or method or payer
    name_col, payer_col, info_col = (1, 2, 3) if card_col == 3 else (0, None, 1)
    last_day = calendar.monthrange(year, mi + 1)[1]
    items, cells, shown, row_total_cells, category, in_table = [], [], [], [], '', True
    for i in range(hi + 1, len(R)):
        r = R[i]
        labels = [txt(r[j]) for j in range(d1)]
        if not any(labels):
            if in_table and any(is_num(r[j]) and r[j] for j in list(day_col.values()) + [total_col]):
                if is_num(r[total_col]):
                    shown = [(i + 1, total_col + 1, float(r[total_col]))]
                in_table = False                             # the table's "total" row — below it are side notes
            continue
        if name_col == 1 and labels[0]:
            category = labels[0]
        name = labels[name_col] or labels[0] or '(no name)'
        info = labels[info_col] if info_col < d1 else ''
        method = info if METHOD.fullmatch(info) else ''
        payer = labels[payer_col] if payer_col is not None else (info if info and not method and not re.fullmatch(r'[\d.\s?]+', info) else '')
        if in_table and is_num(r[total_col]):
            row_total_cells.append((i + 1, total_col + 1, float(r[total_col])))
        for d, j in day_col.items():
            amt, kind = money(r[j])
            if not amt:
                if kind == 'foreign' and in_table:
                    FLAGS.append(f'{key} {src} row {i + 1} "{name}" day {d}: "{txt(r[j])}" not in USD — not imported')
                continue
            cells.append({'field': 'expenses', 'row': i + 1, 'col': j + 1, 'amount': amt, 'kind': kind, 'label': f'{name} (day {d})', 'imported': in_table})
            if not in_table:
                continue
            if kind == 'text':
                FLAGS.append(f'{key} {src} row {i + 1} "{name}" day {d}: "{txt(r[j])}" typed as text — imported as ${amt:,.2f}')
            items.append({'id': hid(src, i, d), 'service': name, 'persona': '', 'method': method,
                          'date': f'{min(d, last_day):02d}.{mi + 1:02d}.{year}', 'cost': round(amt, 2), 'currency': 'USD',
                          'origAmount': round(amt, 2), 'fxRate': 1, 'recurring': False, 'workerLink': '', 'costType': '',
                          'clientName': '', 'salaryStatus': '', 'category': category, 'sheetPayer': payer, 'importedFrom': src})
    return items, cells, (shown or row_total_cells)


# ---------------------------------------------------------------- main
def tab_plan(wb, year):
    for tab in wb.sheetnames:
        t = tab.strip()
        m = re.fullmatch(r'(Revenue|Cost)\s*-\s*([A-Za-z]{3})', t)
        if m:
            if year == 2024 and m.group(1) == 'Revenue' and m.group(2).lower() == 'jan':
                FLAGS.append('2024 file, tab "Revenue - Jan": a draft that mixes November and December 2024 deals — not imported '
                             '(January 2025 comes from the 2025 file)')
                continue
            yield m.group(1), MONTHS[m.group(2).lower()], tab
            continue
        m = re.fullmatch(r'(AD_|Cost )01\.(\d{2})', t)
        if m and year == 2024:
            yield ('Revenue' if m.group(1) == 'AD_' else 'Cost'), int(m.group(2)) - 1, tab


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx2024'); ap.add_argument('xlsx2025')
    ap.add_argument('--roster', required=True, help='a portal full backup (Settings → Full backup) — for the worker list')
    ap.add_argument('--out', required=True)
    ap.add_argument('--targets', default='2024-0..2025-7', help='months to write (key range, 0-based months); the rest is reconciled only')
    a = ap.parse_args()
    lo, hi = (tuple(map(int, k.split('-'))) for k in a.targets.split('..'))
    ym = lambda k: tuple(map(int, k.split('-')))

    roster = {w['name']: w['id'] for w in json.load(open(a.roster))['global_settings'][0]['workers']}
    months, parsed, pay_months, roles = {}, {}, {}, {}
    for path, year in ((a.xlsx2024, 2024), (a.xlsx2025, 2025)):
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        wf = openpyxl.load_workbook(path, data_only=False)          # formulas, for tracing the sheet's own totals
        for kind, mi, tab in tab_plan(wb, year):
            key, src = f'{year}-{mi}', f'sheets{year}:{tab.strip()}'
            R = rows_of(wb[tab])
            md = months.setdefault(key, {'transactions': [], 'expenses': []})
            if kind == 'Revenue':
                layout, deals, cells, shown, skipped, tab_roles = parse_revenue(R, wf[tab], year, mi, src, key)
                md['transactions'] = deals
                for n, role in tab_roles.items():
                    roles.setdefault(n, {})[(year, mi)] = role
                parsed.setdefault(key, []).append(('Revenue', tab.strip(), wf[tab], cells, shown, {'layout': layout, 'emptyRowsSkipped': skipped}))
                for d in deals:
                    for n in d['workerPay']:
                        pay_months.setdefault(n, set()).add((year, mi))
            else:
                items, cells, shown = parse_cost(R, year, mi, src, key)
                md['expenses'] = items
                parsed.setdefault(key, []).append(('Cost', tab.strip(), wf[tab], cells, {'expenses': shown}, {}))

    # the same deal (client, amount, date) in two months — the sheets count it in each; flagged, imported as in the sheets
    seen = {}
    for k, md in months.items():
        for d in md['transactions']:
            if d['date'] and d['payment']:
                seen.setdefault((d['client'].lower(), d['payment'], d['date']), set()).add(k)
    for (c, p, dt), ks in seen.items():
        if len(ks) > 1:
            FLAGS.append(f'"{c}" ${p:,.0f} dated {dt} appears in months {", ".join(sorted(ks, key=ym))} — the sheets count it in each; imported as in the sheets')

    # pending (planned) deals: say in the comment if the same client shows up paid in one of the next three months
    for k, md in months.items():
        for d in md['transactions']:
            if d['status'] != 'pending':
                continue
            later = [(k2, d2) for step in (1, 2, 3) for k2 in [f'{(ym(k)[0] * 12 + ym(k)[1] + step) // 12}-{(ym(k)[0] * 12 + ym(k)[1] + step) % 12}']
                     for d2 in months.get(k2, {}).get('transactions', []) if d2['status'] == 'received' and d2['payment'] > 0
                     and d2['client'].strip('?! ').lower() and d2['client'].strip().lower() == d['client'].strip().lower()]
            note = 'planned — nobody was paid from it in the sheet'
            if later:
                k2, d2 = later[0]
                note += f'; the same client is paid in {ym(k2)[1] + 1:02d}.{ym(k2)[0]} (${d2["payment"]:,.0f})'
            d['comment'] = ' · '.join(x for x in (note, d['comment']) if x)

    # people → portal worker ids; people paid in the sheets who are not in the portal become departed ("Left") members
    workers_add, ids = [], dict(roster)
    for n, ms in sorted(pay_months.items()):
        if n in ids:
            continue
        y, m = max(ms)
        ids[n] = hid('worker', n)
        last_role = roles.get(n, {})[max(roles[n])] if roles.get(n) else ''
        workers_add.append({'id': ids[n], 'name': n, 'role': last_role or 'Former team member', 'colorIdx': (len(roster) + len(workers_add)) % 12,
                            'leftAt': f'{y}-{m + 1:02d}', 'importedFrom': 'sheets-import'})
    for md in months.values():
        for d in md['transactions']:
            d['workerPay'] = {ids[n]: p for n, p in d['workerPay'].items()}

    # reconciliation: each total the sheet shows vs what the portal will show (same rules as FIN.monthTotals)
    recon = {}
    for k in sorted(months, key=ym):
        md = months[k]
        rec = [d for d in md['transactions'] if d['status'] == 'received']
        portal = {'turnover': sum(d['payment'] for d in rec), 'revenue': sum(d['agencyRev'] for d in rec),
                  'expenses': sum(e['cost'] for e in md['expenses'])}
        for n, i in ids.items():
            v = sum(d['workerPay'].get(i, {}).get('amount', 0) for d in md['transactions'])
            if v:
                portal['pay:' + n] = v
        checks, info = [], {}
        for kind, tab, F, cells, shown, extra in parsed[k]:
            info.update(extra)
            fields = ['turnover', 'revenue'] + sorted({f for f in list(shown) + [c['field'] for c in cells] if f.startswith('pay:')}) if kind == 'Revenue' else ['expenses']
            for f in fields:
                checks.append({**trace(F, f, shown.get(f), cells, portal.get(f, 0), k, tab), 'tab': tab})
        recon[k] = {'tabs': [p[1] for p in parsed[k]], 'target': lo <= ym(k) <= hi, **info, 'checks': checks,
                    'deals': len(md['transactions']), 'pending': sum(1 for d in md['transactions'] if d['status'] != 'received'),
                    'expenseRows': len(md['expenses'])}

    targets = sorted((k for k in months if lo <= ym(k) <= hi), key=ym)
    out = {'kind': 'finportal-sheets-import', 'version': 3, 'targets': targets,
           'months': {k: months[k] for k in targets}, 'workersToAdd': workers_add, 'reconcile': recon, 'flags': FLAGS}
    json.dump(out, open(a.out, 'w'), ensure_ascii=False, indent=1)
    bad = [f"{k}:{c['field']}" for k, rc in recon.items() for c in rc['checks'] if c['ok'] is False]
    print(f"targets: {len(targets)} months · deals {sum(len(months[k]['transactions']) for k in targets)} · "
          f"expense rows {sum(len(months[k]['expenses']) for k in targets)} · departed members to add: {len(workers_add)} · "
          f"flags: {len(FLAGS)} · unreconciled totals: {bad or 'none'}")


if __name__ == '__main__':
    main()
