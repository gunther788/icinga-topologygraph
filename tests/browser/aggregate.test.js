// Synthetic hosts aggregating members (vars.synthetic.members and .mode):
// dotted membership lines with a diamond, coloured by whether the aggregate
// holds, and a "needed of all, up" badge.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture} = require('./harness');

const AMBER = '#ffaa44', RED = '#ff5566', BLUE = '#00c3ed';

const view = page => page.evaluate(() => {
    const svg = document.querySelector('.topologygraph-viewport svg');
    const badges = {};
    svg.querySelectorAll('g.topologygraph-badge').forEach(g => {
        const a = g.closest('a');
        badges[a.querySelector('text').textContent] = {
            text: g.querySelector('text').textContent,
            colour: g.querySelector('text').getAttribute('fill'),
            right: g.querySelector('rect').getBBox().x + g.querySelector('rect').getBBox().width,
            labelLeft: a.querySelector('text').getBBox().x
        };
    });
    const members = [...svg.querySelectorAll('path.topologygraph-aggregate')].map(p => ({
        stroke: p.getAttribute('stroke'),
        dashed: !!p.getAttribute('stroke-dasharray'),
        start: p.getAttribute('marker-start'),
        end: p.getAttribute('marker-end')
    }));
    const titles = {};
    svg.querySelectorAll('a').forEach(a => { titles[a.querySelector('text').textContent] = a.querySelector('title').textContent; });
    return {
        badges, members, titles,
        arrows: svg.querySelectorAll('path[marker-end]').length,
        legend: !document.querySelector('.topologygraph-legend-members').hidden
    };
});

for (const layout of ['standard', 'elk']) {
    test(`${layout}: members meet a synthetic host on a dotted line with a diamond, and a badge shows the margin`, async () => {
        const {page, errors, close} = await open({data: fixture('quorum'), query: layout === 'standard' ? '' : '?layout=elk'});
        try {
            await page.waitForTimeout(layout === 'standard' ? 0 : 800);
            const v = await view(page);
            assert.equal(v.members.length, 2, 'one membership line per member box');
            assert.ok(v.members.every(m => m.dashed && m.end === 'none' && /diamond/.test(m.start)), 'dotted, diamond, no arrowhead');
            assert.deepEqual(v.members.map(m => m.stroke).sort(), [BLUE, AMBER].sort(),
                'one worker down but quorum held: amber; all masters up: normal');
            assert.deepEqual([v.badges.dc2_worker_xray2.text, v.badges.dc2_master_xray2.text], ['2 of 3 · 2 up', '2 of 3 · 3 up']);
            assert.equal(v.badges.dc2_worker_xray2.colour, AMBER);
            assert.ok(v.badges.dc2_worker_xray2.right < v.badges.dc2_worker_xray2.labelLeft, 'badge left of the name');
            assert.match(v.titles.dc2_worker_xray2, /quorum: needs 2 of 3 · 2 up/);
            assert.match(v.titles.dc2_worker_xray2, /members down: k8sworker51x2/);
            assert.equal(v.legend, true, 'legend explains the line');
            assert.deepEqual(errors, []);
        } finally {
            await close();
        }
    });
}

test('too few members up: the line and badge turn red', async () => {
    const data = fixture('quorum');
    data.nodes.find(n => n.name === 'k8sworker52x2').state = 1;
    Object.assign(data.nodes.find(n => n.name === 'dc2_worker_xray2').aggregate, {
        up: ['k8sworker53x2'], down: ['k8sworker51x2', 'k8sworker52x2']
    });
    const {page, close} = await open({data});
    try {
        const v = await view(page);
        assert.ok(v.members.some(m => m.stroke === RED));
        assert.equal(v.badges.dc2_worker_xray2.colour, RED);
        assert.equal(v.badges.dc2_worker_xray2.text, '2 of 3 · 1 up');
    } finally {
        await close();
    }
});

test('a live update recolours the line and badge in place', async () => {
    const data = fixture('quorum');
    const {page, server, close} = await open({data, clock: true});
    try {
        const worker = JSON.parse(JSON.stringify(data));
        worker.nodes.find(n => n.name === 'k8sworker51x2').state = 0;
        Object.assign(worker.nodes.find(n => n.name === 'dc2_worker_xray2').aggregate, {
            up: ['k8sworker51x2', 'k8sworker52x2', 'k8sworker53x2'], down: []
        });
        server.data = worker;
        await page.clock.runFor(15000);
        await page.waitForTimeout(200);
        const v = await view(page);
        assert.equal(v.badges.dc2_worker_xray2.text, '2 of 3 · 3 up');
        assert.ok(v.members.every(m => m.stroke === BLUE), 'all members up again: no amber');
    } finally {
        await close();
    }
});

test('no synthetic hosts: no legend entry for members', async () => {
    const {page, close} = await open({data: fixture('small')});
    try {
        const v = await view(page);
        assert.equal(v.legend, false);
        assert.equal(v.members.length, 0);
    } finally {
        await close();
    }
});
