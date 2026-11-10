<?php

/**
 * Tests for GraphExplain. Run with: php tests/php/GraphExplainTest.php
 */

require __DIR__ . '/lib.php';

use Icinga\Module\Topologygraph\Common\GraphExplain;

function node($name, $member, array $groups = [])
{
    return ['name' => $name, 'label' => strtoupper($name), 'member' => $member, 'groups' => $groups];
}

// probe-a and web-1 are members (two graphed groups); db-1 and app-1 outside
$graph = [
    'nodes' => [
        node('probe-a', true, ['synthetic']),
        node('web-1', true, ['web', 'other']),
        node('db-1', false, ['db']),
        node('app-1', false, [])
    ],
    'links' => [
        ['source' => 'probe-a', 'target' => 'web-1'],
        ['source' => 'web-1', 'target' => 'db-1'],
        ['source' => 'db-1', 'target' => 'app-1'],
        ['source' => 'probe-a', 'target' => 'app-1']
    ]
];

$requests = [];
$api = function ($endpoint, $body) use (&$requests) {
    $requests[] = $body;
    if (strpos($endpoint, 'objects/hosts') === 0) {
        // 'lonely' and 'web-2' exist, 'ghost' doesn't
        return array_values(array_filter([
            ['name' => 'lonely', 'attrs' => ['groups' => []]],
            ['name' => 'web-2', 'attrs' => ['display_name' => 'Web 2', 'groups' => ['shop']]],
            ['name' => 'web-3', 'attrs' => ['groups' => []]]
        ], function ($h) use ($body) {
            return in_array($h['name'], $body['filter_vars']['names'], true);
        }));
    }
    return [
        ['attrs' => ['parent_host_name' => 'app-1', 'child_host_name' => 'web-2', 'child_service_name' => '']],
        ['attrs' => ['parent_host_name' => 'nowhere', 'child_host_name' => 'web-3', 'child_service_name' => '']]
    ];
};

$x = GraphExplain::explain($graph, ['synthetic', 'web'], ['db-1', 'lonely', 'web-2', 'web-3', 'ghost'], $api);
$hosts = [];
foreach ($x['hosts'] as $h) {
    $hosts[$h['name']] = $h;
}

check('members first, then by name', array_column($x['hosts'], 'name'), ['probe-a', 'web-1', 'app-1', 'db-1']);
check('drawn as member or outside', array_column($x['hosts'], 'drawn_as'), ['member', 'member', 'outside', 'outside']);
check('why a member is drawn: which graphed group', [$hosts['probe-a']['why_drawn'], $hosts['web-1']['why_drawn']],
    [['in host group synthetic'], ['in host group web']]);
check('why a neighbour is drawn', [$hosts['db-1']['why_drawn'], $hosts['app-1']['why_drawn']],
    [['child of web-1'], ['child of probe-a']]);
check('shown: the selected host and everything above it', [
    $hosts['db-1']['why_shown'], $hosts['web-1']['why_shown'], $hosts['probe-a']['shown'], $hosts['app-1']['shown']
], [['selected'], ['parent of shown host db-1'], true, false]);
check('links: which request found them', array_column($x['links'], 'found'),
    ['touches a member', 'touches a member', 'between two outside hosts', 'touches a member']);

$missing = [];
foreach ($x['selected_but_not_drawn'] as $m) {
    $missing[$m['name']] = $m;
}
check('not drawn: the selected hosts outside the graph', array_keys($missing), ['lonely', 'web-2', 'web-3', 'ghost']);
check('not drawn: connected only to an outside host', $missing['web-2']['reason'],
    'not in the host groups synthetic, web, and it only depends on (or is depended on by) hosts outside them (app-1);'
    . ' the graph draws the groups and their direct neighbours only');
check('not drawn: dependencies listed', $missing['web-2']['host_dependencies'], [['parent' => 'app-1', 'child' => 'web-2']]);
check('not drawn: dependencies leading nowhere drawn',
    strpos($missing['web-3']['reason'], 'none of its host-to-host dependencies') !== false, true);
check('not drawn: no dependencies', strpos($missing['lonely']['reason'], 'no host-to-host dependencies at all') !== false, true);
check('not drawn: unknown host', $missing['ghost']['reason'], 'Icinga has no host with this name');
check('counts', $x['counts'], [
    'drawn' => 4, 'drawn_as_member' => 2, 'drawn_outside' => 2, 'links' => 4, 'shown' => 3, 'selected_but_not_drawn' => 4
]);

// A member of a synthetic host is drawn as its member, not its parent
$withAggregate = $graph;
// (web-1 is a member of the graphed groups; db-1, outside, is its member)
$withAggregate['nodes'][1]['aggregate'] = ['members' => ['db-1'], 'mode' => 'any', 'needed' => 1, 'total' => 1,
    'up' => ['db-1'], 'down' => [], 'unknown' => []];
$withAggregate['links'][] = ['source' => 'db-1', 'target' => 'web-1'];
$byName = [];
foreach (GraphExplain::explain($withAggregate, ['synthetic'], [], $api)['hosts'] as $h) {
    $byName[$h['name']] = $h;
}
check('member of a synthetic host', $byName['db-1']['why_drawn'], ['member of web-1', 'child of web-1']);

// No selection: no extra requests, everything shown
$requests = [];
$plain = GraphExplain::explain($graph, ['synthetic'], [], $api);
check('no selection: no API requests', $requests, []);
check('no selection: everything shown', array_unique(array_column($plain['hosts'], 'shown')), [true]);
check('one group: worded as such', $plain['how_it_works'][0],
    'The graph has the hosts in the synthetic host group, plus the hosts with a host-to-host dependency on one of them.');

finish();
