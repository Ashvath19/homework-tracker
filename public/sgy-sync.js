// "Sync classes" bookmark for Schoology. Settings turns this file into a bookmark (javascript: link).
// Tapped while logged into Schoology, it reads which assignments are in which of your classes from
// your own Schoology pages, then opens the homework site with just that list (class names and
// assignment numbers) in the part of the address after "#", which is never sent to any server.
// It never reads or sends your password, cookies, grades or messages.
(async () => {
  const SITE = '__SITE__';
  if (!/(^|\.)schoology\.com$/.test(location.hostname)) {
    alert('Open Schoology first (any page, while logged in), then tap this bookmark again.');
    return;
  }
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;top:14px;right:14px;max-width:320px;background:#172033;color:#fff;padding:12px 16px;border-radius:10px;font:15px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)';
  document.body.append(box);
  const say = (t) => { box.textContent = t; };
  const get = async (u) => { try { const r = await fetch(u, { credentials: 'same-origin' }); return r.ok ? await r.text() : ''; } catch { return ''; } };

  say('Homework: finding your classes…');
  const courses = new Map();
  // 1) The list Schoology itself uses for the Courses menu.
  try {
    const j = JSON.parse(await get('/iapi2/site-navigation/courses'));
    const list = j?.data?.courses || j?.courses || [];
    for (const c of list) {
      const id = String(c.nid || c.id || c.sectionId || '');
      const name = [c.courseTitle || c.course_title, c.sectionTitle || c.section_title].filter(Boolean).join(': ') || c.title || '';
      if (/^\d+$/.test(id) && name) courses.set(id, name.trim());
    }
  } catch {}
  // 2) Otherwise, the Courses page.
  if (!courses.size) {
    const doc = new DOMParser().parseFromString(await get('/courses'), 'text/html');
    for (const a of doc.querySelectorAll('a[href*="/course/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/course\/(\d+)(?:\/materials)?\/?$/);
      const name = a.textContent.replace(/\s+/g, ' ').trim();
      if (m && name && !courses.has(m[1])) courses.set(m[1], name);
    }
  }
  if (!courses.size) {
    say("Homework: couldn't find your classes. Try again from Schoology's home page.");
    setTimeout(() => box.remove(), 6000);
    return;
  }

  // For each class, collect the assignment / quiz / discussion numbers its pages link to.
  const out = [];
  let i = 0;
  for (const [id, name] of courses) {
    i++;
    say(`Homework: reading ${name} (${i} of ${courses.size})…`);
    const ids = new Set();
    const pages = [`/course/${id}/materials?list_filter=assignment`, `/course/${id}/materials?list_filter=assessment`,
      `/course/${id}/materials?list_filter=discussion`, `/course/${id}/student_grades`, `/course/${id}/materials`];
    for (const p of pages) {
      const html = await get(p);
      for (const m of html.matchAll(/\/(?:assignment|assessment)\/(\d{5,})|\/materials\/discussion\/view\/(\d{5,})/g)) ids.add(m[1] || m[2]);
    }
    out.push({ name, ids: [...ids] });
  }
  const found = out.reduce((n, c) => n + c.ids.length, 0);
  say(`Homework: found ${found} assignments in ${courses.size} classes. Opening your homework site…`);
  const json = JSON.stringify({ v: 1, courses: out });
  const data = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  setTimeout(() => { location.href = `${SITE}/#/sgy-import=${data}`; }, 700);
})();
