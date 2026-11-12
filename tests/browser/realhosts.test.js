// Members checked from several zones (vars.real_host, as in
// python-icinga2-aggregator): every source is drawn as a member, counts are
// per real host and come from the aggregator's own result.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture} = require('./harness');

const look = page => page.evaluate(() => {
    const svg = document.querySelector('.topologygraph-viewport svg');
    const fca = svg.querySelector('a[href="#fca"]');
    return {
        names: [...svg.querySelectorAll('a > text')].map(t => t.textContent).sort(),
        membership: [...svg.querySelectorAll('path.topologygraph-aggregate')].map(p => d3.select(p).datum().parents.slice().sort()),
        forks: svg.querySelectorAll('path.topologygraph-redundant').length,
        badge: fca && fca.querySelector('g.topologygraph-badge text').textContent,
        title: fca && fca.querySelector('title').textContent
    };
});

for (const layout of ['standard', 'elk']) {
    test(`${layout}: every source of a member is drawn as a member, boxed together`, async () => {
        const {page, errors, close} = await open({data: fixture('realhosts'), query: layout === 'standard' ? '' : '?layout=elk'});
        try {
            await page.waitForTimeout(layout === 'standard' ? 0 : 800);
            const v = await look(page);
            assert.deepEqual(v.membership, [['acme', 'acme-stag', 'portal', 'portal-cloud', 'ra', 'ra-stag']],
                'one membership line from the box of all sources');
            assert.equal(v.forks, 0, 'the Member dependencies\' redundancy groups are membership, not alternatives');
            assert.equal(v.badge, '3 of 3 · 3 up', 'counted per real host, from the aggregator');
            assert.deepEqual(errors, []);
        } finally {
            await close();
        }
    });
}

test('the hover text shows the aggregator\'s result and the sources policy', async () => {
    const {page, close} = await open({data: fixture('realhosts')});
    try {
        const v = await look(page);
        assert.match(v.title, /all: needs 3 of 3 · 3 up \(sources: best\)/);
        assert.match(v.title, /aggregator: OK: mode=all, healthy=3\/3; issues: acme-stag \(DOWN, ignored source\)/);
    } finally {
        await close();
    }
});

test('the aggregator\'s count decides the colour, not the hosts drawn', async () => {
    const data = fixture('realhosts');
    Object.assign(data.nodes.find(n => n.name === 'fca_uat_instance').aggregate, {healthy: 2});
    const {page, close} = await open({data});
    try {
        const v = await look(page);
        assert.equal(v.badge, '3 of 3 · 2 up');
        const stroke = await page.$eval('path.topologygraph-aggregate', p => p.getAttribute('stroke'));
        assert.equal(stroke, '#ff5566', 'fewer healthy than needed: red');
    } finally {
        await close();
    }
});

test('collapsing hides every source', async () => {
    const {page, close} = await open({data: fixture('realhosts'), query: '?members=collapsed'});
    try {
        assert.deepEqual((await look(page)).names, ['fca_uat_instance', 'shop.example.com']);
    } finally {
        await close();
    }
});
