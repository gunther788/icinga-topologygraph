// Redundancy groups (Icinga's redundancy_group): a child needs any one parent
// of the group. Each alternative gets its own dashed branch, forking off a
// small circle at the child, coloured by the redundancy left.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture} = require('./harness');

const AMBER = '#ffaa44', RED = '#ff5566', BLUE = '#00c3ed';

// The sample: shop and blog need svc-dc1 or svc-dc2 (svc-dc1 is down) and the
// gateway; blog also needs cache-dc1 or cache-dc2 (both down)
const branches = page => page.evaluate(() => {
    const svg = document.querySelector('.topologygraph-viewport svg');
    return [...svg.querySelectorAll('path[marker-end]')].map(p => {
        const e = d3.select(p).datum();
        return {
            from: e.children.join(','), to: e.parents.join(','),
            redundant: p.classList.contains('topologygraph-redundant'),
            dashed: p.getAttribute('stroke-dasharray'),
            fork: p.getAttribute('marker-start') || '',
            stroke: p.getAttribute('stroke')
        };
    });
});
const find = (list, from, to) => list.find(b => b.from === from && b.to === to);

for (const layout of ['standard', 'elk']) {
    test(`${layout}: alternatives get their own dashed branches, coloured by the redundancy left`, async () => {
        const {page, errors, close} = await open({data: fixture('redundancy'), query: layout === 'standard' ? '' : '?layout=elk'});
        try {
            await page.waitForTimeout(layout === 'standard' ? 0 : 800);
            const b = await branches(page);
            for (const app of ['shop', 'blog']) {
                for (const svc of ['svc-dc1', 'svc-dc2']) {
                    const branch = find(b, app, svc);
                    assert.ok(branch, `${app} -> ${svc}: its own branch, not boxed with the other DC`);
                    assert.ok(branch.redundant && branch.dashed === '6,3' && /fork/.test(branch.fork), 'dashed, forking off a circle');
                }
                assert.equal(find(b, app, 'svc-dc1').stroke, AMBER, 'down, but the other DC is up: amber');
                assert.equal(find(b, app, 'svc-dc2').stroke, BLUE, 'up: normal');
                const gateway = find(b, app, 'gateway');
                assert.ok(gateway && !gateway.redundant && !gateway.dashed && !gateway.fork, 'a required parent: a plain arrow');
            }
            assert.ok(['cache-dc1', 'cache-dc2'].every(c => find(b, 'blog', c).stroke === RED), 'no cache up: red');
            assert.equal(await page.$eval('.topologygraph-legend-redundancy', l => l.hidden), false);
            assert.deepEqual(errors, []);
        } finally {
            await close();
        }
    });
}

test('the hover text lists each redundancy group of a host', async () => {
    const {page, close} = await open({data: fixture('redundancy')});
    try {
        const title = await page.$eval('.topologygraph-viewport a[href="#blog"] title', t => t.textContent);
        assert.match(title, /redundancy group svc: 1 of 2 parents up \(down: svc-dc1\)/);
        assert.match(title, /redundancy group cache: 0 of 2 parents up \(down: cache-dc1, cache-dc2\)/);
    } finally {
        await close();
    }
});

test('a parent coming back up turns its branch back to normal on a live update', async () => {
    const data = fixture('redundancy');
    const {page, server, close} = await open({data, clock: true});
    try {
        const fresh = JSON.parse(JSON.stringify(data));
        fresh.nodes.find(n => n.name === 'svc-dc1').state = 0;
        server.data = fresh;
        await page.clock.runFor(15000);
        await page.waitForTimeout(200);
        assert.equal(find(await branches(page), 'shop', 'svc-dc1').stroke, BLUE);
    } finally {
        await close();
    }
});

test('without redundancy groups nothing is dashed and the legend entry is hidden', async () => {
    const {page, close} = await open({data: fixture('small')});
    try {
        assert.ok((await branches(page)).every(b => !b.redundant && !b.fork));
        assert.equal(await page.$eval('.topologygraph-legend-redundancy', l => l.hidden), true);
    } finally {
        await close();
    }
});
