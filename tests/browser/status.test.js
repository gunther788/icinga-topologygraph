// Host and service status: unreachable, acknowledged and downtime styling,
// service problem rings, arrow colours, hover text and the legend.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture} = require('./harness');

const services = (extra = {}) => Object.assign({
    total: 3, ok: 3, warning: 0, critical: 0, unknown: 0, pending: 0,
    unhandled: 0, worst: 'ok', worst_unhandled: null
}, extra);

function statusSample() {
    const data = fixture('small');
    const set = (name, attrs) => Object.assign(data.nodes.find(n => n.name === name), attrs);
    data.nodes.forEach(n => Object.assign(n, {reachable: true, acknowledged: false, in_downtime: false, services: services()}));
    set('web-2', {state: 1});                                           // down
    set('api-1', {state: 1, reachable: false});                         // unreachable
    set('fw-2', {state: 1, acknowledged: true});                        // handled: acknowledged
    set('lb-1', {state: 1, in_downtime: true});                         // handled: downtime
    set('web-1', {services: services({ok: 2, critical: 1, unhandled: 1, worst: 'critical', worst_unhandled: 'critical'})});
    set('db-1', {services: services({ok: 2, warning: 1, worst: 'warning'})}); // only a handled warning
    set('standalone', {services: null});                               // services not available
    return data;
}

const hostStyle = page => page.evaluate(() => {
    const result = {};
    document.querySelectorAll('.topologygraph-viewport svg a').forEach(a => {
        const [ring, dot] = a.querySelectorAll('circle');
        result[a.querySelector('text').textContent] = {
            fill: dot.getAttribute('fill'),
            fillOpacity: dot.getAttribute('fill-opacity'),
            ring: ring.getAttribute('display') === 'none' ? null : ring.getAttribute('stroke'),
            ringDashed: !!ring.getAttribute('stroke-dasharray'),
            title: a.querySelector('title').textContent
        };
    });
    return result;
});

// Colour and opacity of the arrow from each child (arrows are drawn from the
// child up to its parent), from the drawn paths
const arrowsInto = page => page.evaluate(() => {
    const hosts = [...document.querySelectorAll('.topologygraph-viewport svg a')].map(a => {
        const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(a.getAttribute('transform'));
        return {name: a.querySelector('text').textContent, x: +m[1], y: +m[2]};
    });
    const result = {};
    document.querySelectorAll('.topologygraph-viewport svg path[marker-end]').forEach(path => {
        const n = path.getAttribute('d').match(/-?[\d.]+/g).map(Number);
        const start = {x: n[0], y: n[1]};
        const child = hosts.find(h => Math.abs(h.x - start.x) < 1 && Math.abs(h.y - start.y) < 1);
        (result[child.name] = result[child.name] || []).push({
            stroke: path.getAttribute('stroke'),
            opacity: +path.getAttribute('opacity'),
            width: getComputedStyle(path).strokeWidth,
            marker: path.getAttribute('marker-end')
        });
    });
    return result;
});

test('host states, handled problems and service rings', async () => {
    const {page, errors, close} = await open({data: statusSample()});
    try {
        const s = await hostStyle(page);
        assert.equal(s['web-1'].fill, '#44bb77', 'up');
        assert.equal(s['web-2'].fill, '#ff5566', 'down');
        assert.equal(s['api-1'].fill, '#aa44ff', 'unreachable');
        assert.deepEqual([s['fw-2'].fill, s['fw-2'].fillOpacity], ['#ff5566', '0.45'], 'acknowledged: faded');
        assert.deepEqual([s['lb-1'].fill, s['lb-1'].fillOpacity], ['#ff5566', '0.45'], 'in downtime: faded');
        assert.equal(s['web-2'].fillOpacity, '1', 'unhandled: full colour');

        assert.deepEqual([s['web-1'].ring, s['web-1'].ringDashed], ['#ff5566', false], 'unhandled critical service: solid red ring');
        assert.deepEqual([s['db-1'].ring, s['db-1'].ringDashed], ['#ffaa44', true], 'handled warning only: dashed ring');
        assert.equal(s['web-2'].ring, null, 'all services OK: no ring');

        assert.match(s['api-1'].title, /state: unreachable\n\(down because a parent is down\)/);
        assert.match(s['fw-2'].title, /state: down, acknowledged/);
        assert.match(s['lb-1'].title, /state: down, in downtime/);
        assert.match(s['web-1'].title, /services: 3 \(1 critical\)/);
        assert.match(s['db-1'].title, /services: 3 \(1 warning, 1 handled\)/);
        assert.match(s['web-2'].title, /services: 3, all OK/);
        assert.match(s['standalone'].title, /services: not available/);

        const legend = await page.$$eval('.topologygraph-legend span', items => items.map(i => i.textContent));
        assert.deepEqual(legend, ['up', 'down', 'unreachable (parent down)', 'acknowledged / downtime', 'pending',
            'service problem', 'within the host group', 'to or from other hosts']);
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});

test('arrows take the colour of the child they start from', async () => {
    const {page, close} = await open({data: statusSample()});
    try {
        const a = await arrowsInto(page);
        assert.ok(a['web-2'].every(x => x.stroke === '#ff5566' && x.opacity === 0.85), 'into a down host: red');
        assert.ok(a['api-1'].every(x => x.stroke === '#aa44ff' && x.marker === 'url(#topologygraph-arrow-2)'), 'into an unreachable host: purple');
        assert.ok(a['lb-1'].every(x => x.stroke === '#ff5566' && x.opacity === 0.35), 'into a handled host: faded red');
        assert.ok(a['db-1'].every(x => x.stroke === '#00c3ed' && x.opacity === 0.5), 'into an up host: blue');
        // Unhandled problems are drawn last, on top
        const order = await page.$$eval('.topologygraph-viewport svg path[marker-end]', ps => ps.map(p => +p.getAttribute('opacity')));
        assert.equal(order[order.length - 1], 0.85);
    } finally {
        await close();
    }
});

test('services with notifications disabled can be left out, via the URL or the checkbox', async () => {
    const data = statusSample();
    const set = (name, attrs) => Object.assign(data.nodes.find(n => n.name === name), attrs);
    // web-1's critical service has notifications disabled; db-1's warning has them enabled
    data.nodes.forEach(n => { n.services_notified = n.services; });
    set('web-1', {services_notified: services({total: 2, ok: 2})});
    const ring = page => page.evaluate(() => {
        const result = {};
        document.querySelectorAll('.topologygraph-viewport svg a').forEach(a => {
            const ringElement = a.querySelector('circle');
            result[a.querySelector('text').textContent] = {
                ring: ringElement.getAttribute('display') === 'none' ? null : ringElement.getAttribute('stroke'),
                title: a.querySelector('title').textContent
            };
        });
        return result;
    });
    const url = page => page.evaluate(() => location.pathname + location.search);

    const viaUrl = await open({data, query: '?host=db-1&services=notified'});
    try {
        const r = await ring(viaUrl.page);
        assert.equal(r['web-1'].ring, null, 'no ring: its only problem is a silenced service');
        assert.match(r['web-1'].title, /services with notifications: 2, all OK/);
        assert.equal(r['db-1'].ring, '#ffaa44', 'notified problems still show');
        assert.equal(await viaUrl.page.isChecked('.topologygraph-toggle input'), true, 'checkbox reflects the URL');
        assert.equal(await url(viaUrl.page), '/icingaweb2/topologygraph?host=db-1&services=notified', 'host selection kept alongside');
        assert.deepEqual(viaUrl.errors, []);
    } finally {
        await viaUrl.close();
    }

    const viaCheckbox = await open({data});
    try {
        assert.equal((await ring(viaCheckbox.page))['web-1'].ring, '#ff5566', 'by default every service counts');
        await viaCheckbox.page.check('.topologygraph-toggle input');
        await viaCheckbox.page.waitForTimeout(100);
        assert.equal((await ring(viaCheckbox.page))['web-1'].ring, null, 'ticking the box leaves it out');
        assert.equal(await url(viaCheckbox.page), '/icingaweb2/topologygraph?services=notified');
        await viaCheckbox.page.uncheck('.topologygraph-toggle input');
        await viaCheckbox.page.waitForTimeout(100);
        assert.equal((await ring(viaCheckbox.page))['web-1'].ring, '#ff5566');
        assert.equal(await url(viaCheckbox.page), '/icingaweb2/topologygraph');
    } finally {
        await viaCheckbox.close();
    }
});

test('arrows to or from hosts outside the group are gray', async () => {
    // In the small sample core-router is not in the group; it is the parent of fw-1 and fw-2
    const data = fixture('small');
    const {page, errors, close} = await open({data});
    try {
        const a = await arrowsInto(page);
        assert.ok(a['fw-1'].every(x => x.stroke === '#adb3bc'), 'from a host outside the group: gray');
        assert.ok(a['fw-2'].every(x => x.stroke === '#adb3bc'));
        assert.ok(a['lb-1'].every(x => x.stroke === '#00c3ed'), 'between hosts of the group: blue');
        assert.ok(a['db-1'].every(x => x.stroke === '#00c3ed'));
        // Neither kind looks bolder: same width and opacity
        const gray = a['fw-1'][0], blue = a['lb-1'][0];
        assert.deepEqual([gray.width, gray.opacity], [blue.width, blue.opacity]);
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }

    // A problem still shows in its own colour on a gray arrow
    data.nodes.find(n => n.name === 'fw-1').state = 1;
    const down = await open({data});
    try {
        assert.ok((await arrowsInto(down.page))['fw-1'].every(x => x.stroke === '#ff5566'), 'into a down host: red');
    } finally {
        await down.close();
    }
});

test('hosts of the graphed host groups are drawn as members', async () => {
    // db-1 is in "databases"; graphing that group makes it a member
    const base = fixture('small');
    base.nodes.forEach(n => { n.groups = n.synthetic ? ['synthetic'] : []; delete n.synthetic; });
    base.nodes.find(n => n.name === 'db-1').groups = ['databases'];
    const data = params => {
        const graphed = params.getAll('hostgroup').length ? params.getAll('hostgroup') : ['synthetic'];
        return Object.assign({}, base, {
            nodes: base.nodes.map(n => Object.assign({}, n, {member: n.groups.some(g => graphed.includes(g))})),
            hostgroups: graphed
        });
    };
    const label = (page, name) => page.$eval(`.topologygraph-viewport a[href="#${name}"]`, a => ({
        weight: a.querySelector('text').getAttribute('font-weight'),
        title: a.querySelector('title').textContent
    }));

    const plain = await open({data});
    try {
        const db = await label(plain.page, 'db-1');
        assert.equal(db.weight, 'normal', 'outside the default group');
        assert.match(db.title, /not in the synthetic host group$/m);
        assert.ok((await arrowsInto(plain.page))['db-1'].every(x => x.stroke === '#adb3bc'), 'arrows into it gray');
    } finally {
        await plain.close();
    }
    const both = await open({data, query: '?hostgroup=synthetic&hostgroup=databases'});
    try {
        assert.equal((await label(both.page, 'db-1')).weight, 'bold', 'a member once its group is graphed');
        assert.ok((await arrowsInto(both.page))['db-1'].every(x => x.stroke !== '#adb3bc'), 'arrows into it no longer gray');
        assert.deepEqual(both.errors, []);
    } finally {
        await both.close();
    }
});

test('dependencies between two hosts outside the group are drawn, in gray', async () => {
    // dmz-1 and backend-1 are outside the group, children of group hosts, and
    // backend-1 depends on dmz-1
    const data = fixture('small');
    data.nodes.push(
        {name: 'dmz-1', label: 'dmz-1', state: 0, last_check: 1, synthetic: false, link: '#dmz-1'},
        {name: 'backend-1', label: 'backend-1', state: 0, last_check: 1, synthetic: false, link: '#backend-1'}
    );
    data.links.push(
        {source: 'web-1', target: 'dmz-1'},
        {source: 'api-1', target: 'backend-1'},
        {source: 'dmz-1', target: 'backend-1'}
    );
    const {page, errors, close} = await open({data});
    try {
        const a = await arrowsInto(page);
        assert.ok(a['backend-1'] && a['backend-1'].length === 2, 'both arrows into backend-1 are drawn');
        assert.ok(a['backend-1'].every(x => x.stroke === '#adb3bc'), 'gray');
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});
