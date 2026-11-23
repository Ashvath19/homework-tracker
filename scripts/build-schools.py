"""Builds public/schools/*.json from the official 2026-27 calendars and bell schedules.
Run: python3 scripts/build-schools.py   (re-run after editing; update every summer for the new year)
pattern: weekday = same periods by weekday; rotation = two day types alternating over school days
(anchor = a date known to be labels[0]; specials don't count); None = the student sets the pattern.
"""
import json, datetime as dt, os

def rng(a, b):
    d, e = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    out = []
    while d <= e:
        if d.weekday() < 5: out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out
def days(*items):
    out = []
    for it in items:
        out += rng(*it) if isinstance(it, tuple) else [it]
    for d in out: assert dt.date.fromisoformat(d).weekday() < 5, d
    return sorted(set(out))

WINTER = [('2026-12-21', '2027-01-01')]
SCUSD = dict(first='2026-08-10', last='2027-06-04', src='https://www.santaclarausd.org/calendar',
  off=days('2026-09-07', '2026-09-08', ('2026-10-12', '2026-10-13'), '2026-11-11', ('2026-11-23', '2026-11-27'), *WINTER,
           '2027-01-04', '2027-01-18', ('2027-02-15', '2027-02-19'), ('2027-03-18', '2027-03-19'), ('2027-04-12', '2027-04-16'), '2027-05-31'))
FUHSD = dict(first='2026-08-17', last='2027-06-03', src='https://www.fuhsd.org/about-us/general-information/calendar',
  off=days('2026-09-07', '2026-10-12', '2026-11-11', ('2026-11-25', '2026-11-27'), *WINTER, '2027-01-18',
           ('2027-02-15', '2027-02-19'), '2027-03-15', ('2027-04-12', '2027-04-16'), '2027-05-31'))
LGSUHSD = dict(first='2026-08-12', last='2027-06-03', src='https://www.lgsuhsd.org/resources/calendars-schedules',
  off=days('2026-09-07', '2026-10-12', '2026-11-11', ('2026-11-23', '2026-11-27'), '2026-12-18', *WINTER, '2027-01-18',
           ('2027-02-15', '2027-02-19'), '2027-03-08', ('2027-04-05', '2027-04-09'), '2027-05-31'))
# Labor Day and MLK Day aren't on SJUSD's "important dates" list but are state school holidays (Ed. Code 37220).
SJUSD = dict(first='2026-08-06', last='2027-05-27', src='https://www.sjusd.org/calendar',
  off=days('2026-09-07', ('2026-09-28', '2026-10-02'), '2026-11-11', ('2026-11-25', '2026-11-27'), *WINTER, '2027-01-18',
           ('2027-02-15', '2027-02-19'), ('2027-04-05', '2027-04-09')))
PAUSD = dict(first='2026-08-13', last='2027-06-03', src='https://www.pausd.org/school-life/calendar',
  off=days('2026-09-07', '2026-10-02', '2026-11-11', ('2026-11-23', '2026-11-27'), *WINTER, '2027-01-04', '2027-01-18',
           '2027-02-12', '2027-02-15', '2027-03-15', '2027-03-16', ('2027-04-05', '2027-04-09'), '2027-04-30', '2027-05-31'))
ESUHSD = dict(first='2026-08-06', last='2027-06-03', src='https://www.esuhsd.org',
  off=days('2026-09-07', ('2026-09-28', '2026-10-02'), '2026-11-11', ('2026-11-23', '2026-11-27'), *WINTER, '2027-01-18',
           ('2027-02-15', '2027-02-19'), '2027-03-29', ('2027-04-05', '2027-04-09'), '2027-04-30', '2027-05-31'))

ALL = lambda note='All periods': {'label': 'All', 'note': note}
FIN = lambda note='Finals': {'label': 'Finals', 'note': note}
def sp(dates, v): return {d: v for d in (dates if isinstance(dates, list) else [dates])}

schools = []
def school(id, name, place, cal, pattern, sources, **kw):
    schools.append(dict(id=id, name=name, place=place, year='2026-27', first=cal['first'], last=cal['last'],
                        sources=sources + [cal['src']], pattern=pattern, off=cal['off'], **kw))

# ---- Santa Clara Unified ----
ODD_EVEN = {'type': 'weekday', 'days': {'1': 'All', '2': 'Odd', '3': 'Even', '4': 'Odd', '5': 'Even'}}
school('wilcox', 'Wilcox High School', 'Santa Clara', SCUSD, ODD_EVEN, ['https://wilcox.santaclarausd.org/about/bell-schedule'],
  labelNames={'All': 'All periods', 'Odd': 'Odd periods (1, 3, 5, 7)', 'Even': 'Even periods (2, 4, 6)'}, classDays=['Odd', 'Even'],
  special={**sp(['2026-08-11', '2026-08-12'], ALL('All periods (1-7)')),
           **sp(['2026-09-09', '2026-10-14', '2026-11-10', '2026-12-15'], ALL('Adjusted schedule, all periods (1-7)')),
           '2026-12-16': FIN('Finals: periods 1, 2, 7'), '2026-12-17': FIN('Finals: periods 3, 4'), '2026-12-18': FIN('Finals: periods 5, 6')})
school('santa-clara-high', 'Santa Clara High School', 'Santa Clara', SCUSD, ODD_EVEN, ['https://santaclara.santaclarausd.org/about-us/bell-schedule'],
  labelNames={'All': 'All periods', 'Odd': 'Odd periods (1, 3, 5, 7)', 'Even': 'Even periods (2, 4, 6)'}, classDays=['Odd', 'Even'],
  special={'2026-11-09': {'label': 'Even', 'note': 'Special schedule: uses the Wed/Fri bell schedule'}})

# ---- Fremont Union (all five use the same weekly pattern) ----
FU = {'type': 'weekday', 'days': {'1': 'All', '2': 'Tue/Thu', '3': 'Wed/Fri', '4': 'Tue/Thu', '5': 'Wed/Fri'}}
for id, name, place, page in [
    ('lynbrook', 'Lynbrook High School', 'San Jose', 'https://lhs.fuhsd.org/about-us/general-information/bell-schedule'),
    ('monta-vista', 'Monta Vista High School', 'Cupertino', 'https://mvhs.fuhsd.org/about-us/general-information/bell-schedule'),
    ('cupertino', 'Cupertino High School', 'Cupertino', 'https://chs.fuhsd.org/about-us/general-information/bell-schedules'),
    ('homestead', 'Homestead High School', 'Cupertino', 'https://hhs.fuhsd.org/about-us/general-information/bell-schedule'),
    ('fremont', 'Fremont High School', 'Sunnyvale', 'https://fhs.fuhsd.org/about-us/general-information/bell-schedule')]:
    school(id, name, place, FUHSD, FU, [page], classDays=['Tue/Thu', 'Wed/Fri'], short={'Tue/Thu': 'TTh', 'Wed/Fri': 'WF'},
           labelNames={'All': 'All periods', 'Tue/Thu': 'Periods 1, 2, 3, 7', 'Wed/Fri': 'Periods 4, 5, 6'})

# ---- Los Gatos-Saratoga ----
# LGHS: Orange (odd periods) / Black (even) alternate every school day from Aug 12 (Orange); finals don't count.
# Worked out from the per-month Orange/Black day counts on the LGHS Orange/Black calendar, which all match.
school('los-gatos', 'Los Gatos High School', 'Los Gatos', LGSUHSD,
  {'type': 'rotation', 'labels': ['Orange', 'Black'], 'anchor': '2026-08-12'},
  ['https://www.lghs.net/about-us/calendarschedules'], classDays=['Orange', 'Black'], short={'Orange': 'Or', 'Black': 'Bl'},
  labelNames={'Orange': 'Orange day (odd periods)', 'Black': 'Black day (even periods)'},
  special=sp(days(('2026-12-14', '2026-12-17'), '2027-05-28', ('2027-06-01', '2027-06-03')), FIN()))
# SHS: Red/Blue days alternate, but the calendar only shows them as colors, so the student says which today is.
school('saratoga', 'Saratoga High School', 'Saratoga', LGSUHSD, {'type': 'rotation', 'labels': ['Red', 'Blue']},
  ['https://www.saratogahigh.org/about-us/calendars-and-schedules'], classDays=['Red', 'Blue'],
  labelNames={'Red': 'Red day', 'Blue': 'Blue day'},
  special={'2026-12-14': ALL('Finals week: all periods, short'), **sp(days(('2026-12-15', '2026-12-17')), FIN()),
           '2027-05-28': ALL('Finals week: all periods, short'), **sp(days(('2027-06-01', '2027-06-03')), FIN())})

# ---- San Jose Unified ----
school('leland', 'Leland High School', 'San Jose', SJUSD,
  {'type': 'weekday', 'days': {'1': 'All', '2': 'Gold', '3': 'Blue', '4': 'Gold', '5': 'Blue'}},
  ['https://leland.sjusd.org/about/bell-schedule'], classDays=['Gold', 'Blue'], short={'Gold': 'Gld'},
  labelNames={'All': 'All periods', 'Gold': 'Gold day (1, 3, 5)', 'Blue': 'Blue day (2, 4, 6)'},
  special={**sp(['2026-08-06', '2026-08-07', '2026-12-14', '2026-12-15', '2027-05-24'], ALL()),
           **sp(['2026-08-17', '2026-10-12', '2026-11-09', '2026-11-23', '2027-04-26'], {'label': 'Blue', 'note': 'Blue Monday (2, 4, 6)'}),
           **sp(days(('2026-12-16', '2026-12-18'), ('2027-05-25', '2027-05-27')), FIN())})
school('san-jose-high', 'San José High School', 'San Jose', SJUSD,
  {'type': 'weekday', 'days': {'1': 'Crimson', '2': 'Silver', '3': 'Crimson', '4': 'Silver', '5': 'All'}},
  ['https://sjhs.sjusd.org/about/bell-schedule'], classDays=['Crimson', 'Silver'], short={'Crimson': 'Crm', 'Silver': 'Slv'},
  labelNames={'All': 'Bulldog day (all periods)', 'Crimson': 'Crimson day (1, 3, 5, 7)', 'Silver': 'Silver day (2, 4, 6, 7)'},
  special={**sp(['2026-09-11', '2026-11-13', '2027-01-22'], {'label': 'Crimson', 'note': 'Crimson day on a Friday'}),
           **sp(['2026-09-03', '2027-02-04'], {'label': 'Silver', 'note': 'Rally day: periods 2, 4, 6, 7'}),
           '2026-12-14': ALL('Minimum day'), **sp(days(('2026-12-15', '2026-12-18'), ('2027-05-24', '2027-05-27')), FIN()),
           **sp(days(('2027-03-22', '2027-03-25')), {'label': 'All', 'note': 'State testing schedule'})})
for id, name in [('lincoln', 'Lincoln High School'), ('willow-glen', 'Willow Glen High School'), ('pioneer', 'Pioneer High School'), ('gunderson', 'Gunderson High School')]:
    school(id, name, 'San Jose', SJUSD, None, [f'https://{id.replace("-", "")}.sjusd.org'])

# ---- Palo Alto Unified ----
school('gunn', 'Gunn High School', 'Palo Alto', PAUSD,
  {'type': 'weekday', 'days': {'1': 'All', '2': '1-4', '3': '5-7', '4': '1-4', '5': '5-7'}},
  ['https://gunn.pausd.org/campus-life/bell-schedule'], classDays=['1-4', '5-7'],
  labelNames={'All': 'All periods', '1-4': 'Periods 1, 2, 3, 4', '5-7': 'Periods 5, 6, 7'})
school('palo-alto-high', 'Palo Alto High School', 'Palo Alto', PAUSD,
  {'type': 'weekday', 'days': {'1': 'All', '2': 'A', '3': 'B', '4': 'A', '5': 'B'}},
  ['https://www.paly.net/campus-life/daily-bell-schedule'], classDays=['A', 'B'],
  labelNames={'All': '7-period day', 'A': 'A day (1, 2, 3, 4)', 'B': 'B day (5, 6, 7)'})

# ---- East Side Union (district calendar; each school's weekly pattern is set by the student) ----
for id, name in [('evergreen-valley', 'Evergreen Valley High School'), ('silver-creek', 'Silver Creek High School'),
                 ('santa-teresa', 'Santa Teresa High School'), ('piedmont-hills', 'Piedmont Hills High School'),
                 ('independence', 'Independence High School'), ('james-lick', 'James Lick High School'),
                 ('mount-pleasant', 'Mount Pleasant High School'), ('oak-grove', 'Oak Grove High School'),
                 ('yerba-buena', 'Yerba Buena High School'), ('andrew-hill', 'Andrew Hill High School'),
                 ('overfelt', 'W.C. Overfelt High School')]:
    school(id, name, 'San Jose', ESUHSD, None, [])

# ---- Private schools ----
BCP = dict(first='2026-08-13', last='2027-05-25', src='https://bcp.org/important-student-dates',
  off=days('2026-09-07', '2026-09-14', ('2026-10-15', '2026-10-16'), ('2026-11-23', '2026-11-27'), ('2026-12-21', '2027-01-04'),
           ('2027-01-14', '2027-01-15'), '2027-01-18', ('2027-02-15', '2027-02-19'), '2027-03-08', ('2027-03-26', '2027-04-05'),
           '2027-04-26', '2027-05-17'))
school('bellarmine', 'Bellarmine College Prep', 'San Jose', BCP, {'type': 'weekday', 'days': {str(d): '' for d in range(1, 6)}},
  ['https://bcp.org/academics/daily-class-schedule'], classDays=[])
# Mitty's page calls its 2026-27 dates "proposed".
MITTY = dict(first='2026-08-18', last='2027-05-26', src='https://www.mitty.com/about-amhs/amhs-holidays-and-important-dates',
  off=days('2026-09-07', '2026-09-16', '2026-09-25', '2026-10-12', '2026-10-28', '2026-11-09', ('2026-11-25', '2026-11-27'),
           ('2026-12-21', '2027-01-05'), '2027-01-18', '2027-02-12', '2027-02-15', '2027-03-05', '2027-03-26',
           ('2027-03-29', '2027-04-02'), '2027-04-21', '2027-04-26'))
school('mitty', 'Archbishop Mitty High School', 'San Jose', MITTY, None, [])

# ---- Valley Christian (same campus calendar VCS Moodle accounts use: api/_schoolDays.json) ----
# The A/B days there alternate over school days, skipping days off and C days, so a rotation
# anchored on the first day reproduces every letter exactly (checked below).
VCS_DAYS = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'api', '_schoolDays.json')))['days']
VCS = dict(first=min(VCS_DAYS), last=max(VCS_DAYS), src='https://www.vcs.net',
  off=[d for d in rng(min(VCS_DAYS), max(VCS_DAYS)) if d not in VCS_DAYS])
VCS_C = {d: {'label': 'C', 'note': 'C day (special schedule)'} for d, v in VCS_DAYS.items() if v == 'C'}
school('vchs', 'Valley Christian High School', 'San Jose', VCS, {'type': 'rotation', 'labels': ['A', 'B'], 'anchor': min(VCS_DAYS)},
  ['Learn@VCS: VCHS Campus Calendar 2026-27'], classDays=['A', 'B'],
  labelNames={'A': 'A day', 'B': 'B day', 'C': 'C day'}, special=VCS_C)
_ab = [v for d, v in sorted(VCS_DAYS.items()) if v != 'C']
assert all(v == 'AB'[i % 2] for i, v in enumerate(_ab)), 'VCHS A/B days no longer alternate; use per-day letters'
# The junior high shares the campus calendar, but its weekly schedule isn't published, so students set it.
school('vcjh', 'Valley Christian Junior High', 'San Jose', VCS, None, ['Learn@VCS: VCHS Campus Calendar 2026-27'])

out = os.path.join(os.path.dirname(__file__), '..', 'public', 'schools')
index = []
for s in schools:
    s['special'] = s.get('special', {})
    for d in s['special']: assert d not in s['off'] and s['first'] <= d <= s['last'], (s['id'], d)
    for d in s['off']: assert s['first'] <= d <= s['last'], (s['id'], d)
    s.setdefault('labelNames', {}); s.setdefault('classDays', []); s.setdefault('short', {})
    json.dump(s, open(os.path.join(out, s['id'] + '.json'), 'w'), indent=1)
    index.append({'id': s['id'], 'name': s['name'], 'place': s['place'], 'needs': 'pattern' if s['pattern'] is None else
                  'today' if s['pattern']['type'] == 'rotation' and 'anchor' not in s['pattern'] else None})
index.sort(key=lambda x: x['name'])
json.dump({'note': 'Built by scripts/build-schools.py. One school year per file; rebuild every summer. VCS Moodle accounts use api/_schoolDays.json; vchs/vcjh are built from it.',
           'schools': index}, open(os.path.join(out, 'index.json'), 'w'), indent=1)
print(len(schools), 'schools')
