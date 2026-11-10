<?php

/**
 * Tests for GraphBuilder. Plain PHP, no framework: run with
 *
 *     php tests/php/GraphBuilderTest.php
 *
 * Exits non-zero if any check fails.
 */

require __DIR__ . '/lib.php';

use Icinga\Module\Topologygraph\Common\GraphBuilder;

function host($name, array $attrs = [])
{
    return ['name' => $name, 'attrs' => $attrs + ['display_name' => $name, 'groups' => []]];
}

function dependency($parent, $child, $childService = '')
{
    return ['attrs' => [
        'parent_host_name' => $parent, 'child_host_name' => $child, 'child_service_name' => $childService
    ]];
}

function service($host, $state, array $attrs = [])
{
    return ['attrs' => $attrs + ['host_name' => $host, 'state' => $state, 'last_check' => 1000]];
}

// --- select() ---------------------------------------------------------------

$hosts = [
    host('probe-a', ['groups' => ['synthetic']]),
    host('probe-b', ['groups' => ['synthetic', 'other']]),
    host('fw-1'),
    host('db-1'),
    host('unrelated'),
    host('123', ['groups' => ['synthetic']]) // numeric name
];
$dependencies = [
    dependency('fw-1', 'probe-a'),    // non-synthetic parent of a synthetic host
    dependency('probe-b', 'db-1'),    // non-synthetic child of a synthetic host
    dependency('fw-1', 'unrelated'),  // touches no synthetic host: ignored
    dependency('fw-1', 'probe-a'),    // duplicate: kept once
    dependency('probe-a', 'probe-a'), // self-loop: ignored
    dependency('db-1', 'probe-b', 'http'), // service dependency: ignored
];
$selection = GraphBuilder::select($hosts, $dependencies, 'synthetic');
$names = $selection['names'];
sort($names);

check('select: synthetic hosts plus their direct neighbours', $names, ['123', 'db-1', 'fw-1', 'probe-a', 'probe-b']);
check('select: numeric host names stay strings', in_array('123', $selection['names'], true), true);
check('select: only links touching synthetic hosts, without duplicates', $selection['links'], [
    ['source' => 'fw-1', 'target' => 'probe-a'],
    ['source' => 'probe-b', 'target' => 'db-1']
]);
check('select: group membership', array_map('strval', array_keys($selection['members'])), ['probe-a', 'probe-b', '123']);

$both = GraphBuilder::select(
    [host('probe-a', ['groups' => ['synthetic']]), host('web-1', ['groups' => ['web']]), host('db-1')],
    [dependency('probe-a', 'db-1'), dependency('db-1', 'web-1')],
    ['synthetic', 'web']
);
check('select: several groups are all members', array_keys($both['members']), ['probe-a', 'web-1']);
check('select: neighbours of any of them', $both['names'], ['probe-a', 'web-1', 'db-1']);

// --- addLinksAmong() --------------------------------------------------------

$among = GraphBuilder::addLinksAmong($selection, [
    dependency('fw-1', 'db-1'),       // both drawn, neither in the group: added
    dependency('fw-1', 'unrelated'),  // 'unrelated' isn't drawn: ignored
    dependency('fw-1', 'probe-a'),    // already there: not duplicated
    dependency('db-1', 'db-1'),       // self-loop: ignored
    dependency('fw-1', 'db-1', 'disk') // service dependency: ignored
]);
check('links among drawn hosts: only the new one added', $among['links'], array_merge($selection['links'], [
    ['source' => 'fw-1', 'target' => 'db-1']
]));
check('links among drawn hosts: hosts unchanged', $among['names'], $selection['names']);

// --- summariseServices() ----------------------------------------------------

$summary = GraphBuilder::summariseServices([
    service('probe-a', 0),
    service('probe-a', 1),
    service('probe-a', 2, ['acknowledgement' => 1]), // handled critical
    service('probe-a', 3),
    service('probe-a', 0, ['last_check' => 0]),      // pending
    service('probe-b', 2, ['downtime_depth' => 1]),  // handled critical only
    service('db-1', 0)
]);

check('services: counts per state', [
    $summary['probe-a']['total'], $summary['probe-a']['ok'], $summary['probe-a']['warning'],
    $summary['probe-a']['critical'], $summary['probe-a']['unknown'], $summary['probe-a']['pending']
], [5, 1, 1, 1, 1, 1]);
check('services: worst state counts handled problems', $summary['probe-a']['worst'], 'critical');
check('services: worst unhandled state skips acknowledged ones', $summary['probe-a']['worst_unhandled'], 'unknown');
check('services: unhandled count', $summary['probe-a']['unhandled'], 2);
check('services: only handled problems leave no unhandled worst', [
    $summary['probe-b']['worst'], $summary['probe-b']['worst_unhandled'], $summary['probe-b']['unhandled']
], ['critical', null, 0]);
check('services: all OK', [$summary['db-1']['worst'], $summary['db-1']['unhandled']], ['ok', 0]);

// --- summariseServices() with only notified services ------------------------

$mixed = [
    service('probe-a', 2, ['enable_notifications' => false]), // critical, but nobody is notified
    service('probe-a', 1, ['enable_notifications' => true]),
    service('probe-a', 0),                                    // no attribute: treated as enabled
    service('db-1', 2, ['enable_notifications' => false])     // the host's only service
];
$all = GraphBuilder::summariseServices($mixed);
$notified = GraphBuilder::summariseServices($mixed, true);
check('notified only: all services counted by default', [$all['probe-a']['total'], $all['probe-a']['worst_unhandled']], [3, 'critical']);
check('notified only: services with notifications disabled are left out',
    [$notified['probe-a']['total'], $notified['probe-a']['critical'], $notified['probe-a']['worst_unhandled']], [2, 0, 'warning']);
check('notified only: a host with only such services has no entry', isset($notified['db-1']), false);

// --- build() ----------------------------------------------------------------

$hosts[0]['attrs'] += ['state' => 1, 'last_check' => 5, 'last_reachable' => false, 'zone' => 'z1'];
$hosts[1]['attrs'] += ['state' => 1, 'last_check' => 5, 'last_reachable' => true, 'acknowledgement' => 1];
$hosts[2]['attrs'] += ['state' => 1, 'last_check' => 5, 'downtime_depth' => 2];
$graph = GraphBuilder::build($selection, $hosts, [service('probe-a', 2)], '/icingaweb2/icingadb/host?name=');
$byName = [];
foreach ($graph['nodes'] as $node) {
    $byName[$node['name']] = $node;
}

check('build: one node per selected host', count($graph['nodes']), 5);
check('build: unreachable host', [$byName['probe-a']['reachable'], $byName['probe-a']['zone']], [false, 'z1']);
check('build: acknowledged host', [$byName['probe-b']['acknowledged'], $byName['probe-b']['in_downtime']], [true, false]);
check('build: host in downtime', [$byName['fw-1']['acknowledged'], $byName['fw-1']['in_downtime']], [false, true]);
check('build: service summary attached', $byName['probe-a']['services']['worst_unhandled'], 'critical');
check('build: host without services gets an empty summary', $byName['db-1']['services']['total'], 0);
check('build: link to the host page is URL-encoded', $byName['probe-a']['link'], '/icingaweb2/icingadb/host?name=probe-a');
check('build: links passed through', $graph['links'], $selection['links']);
check('build: host groups passed through', [$byName['probe-b']['groups'], $byName['db-1']['groups']], [['synthetic', 'other'], []]);

$withoutServices = GraphBuilder::build($selection, $hosts, null, '/x?host=');
check('build: services null when they could not be fetched', $withoutServices['nodes'][0]['services'], null);
check('build: notified summary null too', $withoutServices['nodes'][0]['services_notified'], null);

$graphMixed = GraphBuilder::build($selection, $hosts, $mixed, '/x?host=');
$mixedByName = [];
foreach ($graphMixed['nodes'] as $node) {
    $mixedByName[$node['name']] = $node;
}
check('build: both summaries attached', [
    $mixedByName['probe-a']['services']['worst_unhandled'], $mixedByName['probe-a']['services_notified']['worst_unhandled']
], ['critical', 'warning']);
check('build: notified summary empty for a host with only silenced services', [
    $mixedByName['db-1']['services']['total'], $mixedByName['db-1']['services_notified']['total']
], [1, 0]);

// --- aggregate() ------------------------------------------------------------

$workers = [
    'w1' => ['state' => 1.0, 'last_check' => 5],   // down (the API sends floats)
    'w2' => ['state' => 0.0, 'last_check' => 5],
    'w3' => ['state' => 0, 'last_check' => 5],
    'w4' => ['state' => 0, 'last_check' => 0]      // pending
];
$synthetic = function ($mode, array $members = ['w1', 'w2', 'w3']) {
    return ['vars' => ['synthetic' => ['members' => $members, 'parents' => $members, 'mode' => $mode]]];
};
$quorum = GraphBuilder::aggregate($synthetic('quorum'), $workers);
check('aggregate: quorum needs a majority', [$quorum['mode'], $quorum['needed'], $quorum['total']], ['quorum', 2, 3]);
check('aggregate: members up and down', [$quorum['up'], $quorum['down'], $quorum['unknown']], [['w2', 'w3'], ['w1'], []]);
check('aggregate: any needs one, all needs every member', [
    GraphBuilder::aggregate($synthetic('any'), $workers)['needed'], GraphBuilder::aggregate($synthetic('ALL '), $workers)['needed']
], [1, 3]);
check('aggregate: quorum of four needs three', GraphBuilder::aggregate($synthetic('quorum', ['w1', 'w2', 'w3', 'w4']), $workers)['needed'], 3);
check('aggregate: a number is a threshold (at most all)', [
    GraphBuilder::aggregate($synthetic('2'), $workers)['needed'], GraphBuilder::aggregate($synthetic('9'), $workers)['needed']
], [2, 3]);
check('aggregate: unknown mode has no threshold', GraphBuilder::aggregate($synthetic('best-effort'), $workers)['needed'], null);
check('aggregate: no mode means all', GraphBuilder::aggregate(['vars' => ['synthetic' => ['members' => ['w2']]]], $workers)['needed'], 1);
check('aggregate: pending and unknown members are not up',
    GraphBuilder::aggregate($synthetic('any', ['w4', 'gone']), $workers)['unknown'], ['w4', 'gone']);
check('aggregate: none for ordinary hosts', [
    GraphBuilder::aggregate(['vars' => ['synthetic' => ['parents' => ['w1']]]], $workers), GraphBuilder::aggregate(null, $workers)
], [null, null]);
check('aggregate members of several hosts, once each', GraphBuilder::aggregateMembers([
    ['name' => 'q1', 'attrs' => $synthetic('quorum')], ['name' => 'q2', 'attrs' => $synthetic('any', ['w3', 'w4'])], ['name' => 'x', 'attrs' => []]
]), ['w1', 'w2', 'w3', 'w4']);

finish();
