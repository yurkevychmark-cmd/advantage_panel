#!/usr/bin/env python3
"""Print the per-month reconciliation from a sheets_import.py payload; optionally re-check it against live portal data.

    python3 reconcile.py <payload.json> [--portal <portal backup .json | monthly_data dump .json>] [--brief]

For every total the sheet shows (turnover, agency REV, each person's pay, expenses): the value in the sheet and the
cell/formula it comes from, what the portal shows, and the difference decomposed into amounts typed as text (SUM skips
them) and imported cells the formula's range does not reach. With --portal the "portal" figures are recomputed from
the live data (same rules as FIN.monthTotals) — that is the after-import proof.
"""
import argparse, json

MON = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()


def fmt(v):
    return '—' if v is None else f'{v:,.2f}'.rstrip('0').rstrip('.')


def num(v):
    try:
        return float(str(v).replace(',', '.')) if v not in (None, '') else 0.0
    except ValueError:
        return 0.0


def live_totals(data, names):
    tx, ex = data.get('transactions') or [], data.get('expenses') or []
    rec = [t for t in tx if t.get('status') == 'received']
    out = {'turnover': sum(num(t.get('payment')) for t in rec), 'revenue': sum(num(t.get('agencyRev')) for t in rec),
           'expenses': sum(num(e.get('cost')) for e in ex)}
    for t in tx:
        for wid, p in (t.get('workerPay') or {}).items():
            if num(p.get('amount')):
                f = 'pay:' + names.get(wid, wid)
                out[f] = out.get(f, 0) + num(p.get('amount'))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('payload'); ap.add_argument('--portal'); ap.add_argument('--brief', action='store_true')
    a = ap.parse_args()
    p = json.load(open(a.payload))
    live = None
    if a.portal:
        b = json.load(open(a.portal))
        rows = b['monthly_data'] if isinstance(b, dict) else b
        names = {w['id']: w['name'] for w in ((b.get('global_settings') or [{}])[0].get('workers') or [])} if isinstance(b, dict) else {}
        names.update({w['id']: w['name'] for w in p['workersToAdd']})
        live = {r['month_key']: live_totals(r['data'] or {}, names) for r in rows}
    all_ok = True
    for k, rc in p['reconcile'].items():
        y, m = map(int, k.split('-'))
        lines, month_ok = [], True
        for c in rc['checks']:
            portal = (live.get(k, {}).get(c['field'], 0) if live is not None else c['portal'])
            if c['shown'] is None:
                if c['field'] in ('turnover', 'revenue', 'expenses'):
                    lines.append(f"  {c['field']:<16} sheet shows no total · portal {fmt(portal)}")
                continue
            expl = sum(x[2] for x in c['outsideRange']) - sum(x[2] for x in c['notImported']) + sum(x[2] for x in c['textAmounts'])
            ok = abs(c['shown'] + expl - portal) < 0.01
            month_ok = month_ok and ok
            diff = portal - c['shown']
            if a.brief and abs(diff) < 0.01 and c['field'].startswith('pay:'):
                continue
            s = f"  {c['field']:<16} sheet {fmt(c['shown']):>9} · portal {fmt(portal):>9}"
            if abs(diff) >= 0.01:
                parts = [f"text {fmt(x[2])} ({x[1]}, {x[0]})" for x in c['textAmounts']] + \
                        [f"outside the sheet's SUM {fmt(x[2])} ({x[1]}, {x[0]})" for x in c['outsideRange']] + \
                        [f"not imported −{fmt(x[2])} ({x[1]}, {x[0]})" for x in c['notImported']]
                s += f"  Δ {fmt(diff)} = " + ' + '.join(parts) if parts else f'  Δ {fmt(diff)} UNEXPLAINED'
            if not ok:
                s += '   ✗'
            if not (a.brief and c['field'].startswith('pay:')) or not ok or abs(diff) >= 0.01:
                lines.append(s)
        pays = [c for c in rc['checks'] if c['field'].startswith('pay:') and c['shown'] is not None]
        if a.brief and pays:
            lines.append(f"  people           {len(pays)} totals in the sheet, all match the portal" if all(
                abs(c['shown'] + sum(x[2] for x in c['outsideRange']) - sum(x[2] for x in c['notImported']) + sum(x[2] for x in c['textAmounts'])
                    - (live.get(k, {}).get(c['field'], 0) if live is not None else c['portal'])) < 0.01 for c in pays) else '  people           ✗ see full output')
        all_ok = all_ok and month_ok
        tag = 'import' if rc['target'] else 'already in the portal — compare only'
        pending = f" (pending {rc['pending']})" if rc.get('pending') else ''
        print(f"{'✓' if month_ok else '✗'} {MON[m]} {y} [{k}] {tag} · {', '.join(rc['tabs'])} · deals {rc['deals']}{pending} · expense rows {rc['expenseRows']}")
        print('\n'.join(lines))
    print('\nALL MONTHS RECONCILE' if all_ok else '\nSOME TOTALS DO NOT RECONCILE (✗)')
    return 0 if all_ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
