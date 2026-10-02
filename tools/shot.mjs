// node tools/shot.mjs "<query>" out.png [waitMs] [js-to-eval-before-wait]  — render headless (GPU), report console errors
import { launch } from './browser.mjs';
const [q = 'demo&still', out = 'shot.png', wait = '2500', js = ''] = process.argv.slice(2);
const base = process.env.SKILL_TANK_URL || 'http://127.0.0.1:4700/';
const errors = [];
const b = await launch();
const vp = (process.env.VP || '1440x860').split('x').map(Number);
const p = await b.newPage({ viewport: { width: vp[0], height: vp[1] }, hasTouch: !!process.env.TOUCH, isMobile: !!process.env.TOUCH });
p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await p.goto(q.startsWith('file:') ? q : base + '?' + q);
await p.waitForFunction(() => window.__ready, null, { timeout: 60000 });
if (js) await p.evaluate(js);
await p.waitForTimeout(+wait);
await p.screenshot({ path: out });
console.log(JSON.stringify(await p.evaluate(() => window.__tank && window.__tank.stats())));
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no errors');
await b.close();
