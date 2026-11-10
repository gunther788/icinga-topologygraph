<?php

/**
 * Tests for GraphSource: which API requests are made, with which filters,
 * and how their results are combined. Run with: php tests/php/GraphSourceTest.php
 */

require __DIR__ . '/lib.php';

use Icinga\Module\Topologygraph\Common\GraphSource;

/**
 * A fake Icinga API: answers each request from $answers by its kind
 * (hosts / dependencies / services) and records the requests made.
 */
function fakeApi(array $answers, array &$requests)
{
    return function ($endpoint, $body) use ($answers, &$requests) {
        $kind = explode('?', substr($endpoint, strlen('objects/')))[0];
        $requests[] = ['kind' => $kind, 'filter' => $body['filter'], 'vars' => $body['filter_vars']];
        $answer = $answers[$kind];
        if ($answer instanceof \Exception) {
            throw $answer;
        }
        return is_callable($answer) ? $answer($body) : $answer;
    };
}

function host($name, array $attrs = [])
{
    return ['name' => $name, 'attrs' => $attrs + ['display_name' => $name, 'groups' => [], 'state' => 0, 'last_check' => 1]];
}

$answers = [
    'hosts' => function ($body) {
        // First request: the group; second: neighbours by name
        if ($body['filter'] === 'group in host.groups') {
            return [host('probe-a', ['groups' => ['web-checks']]), host('probe-b', ['groups' => ['web-checks']])];
        }
        return array_map('host', $body['filter_vars']['names']);
    },
    'dependencies' => [
        ['attrs' => ['parent_host_name' => 'probe-a', 'child_host_name' => 'web-1', 'child_service_name' => '']],
        ['attrs' => ['parent_host_name' => 'probe-b', 'child_host_name' => 'web-1', 'child_service_name' => '']]
    ],
    'services' => [
        ['attrs' => ['host_name' => 'web-1', 'state' => 2, 'last_check' => 1]]
    ]
];

$requests = [];
$graph = GraphSource::fetch(fakeApi($answers, $requests), 'web-checks', '/host?name=');
$names = array_column($graph['nodes'], 'name');
sort($names);

check('requests: group hosts, dependencies, neighbours, services', array_column($requests, 'kind'),
    ['hosts', 'dependencies', 'hosts', 'services']);
check('group hosts are filtered on the Icinga side', [$requests[0]['filter'], $requests[0]['vars']],
    ['group in host.groups', ['group' => 'web-checks']]);
check('dependencies: host-to-host ones touching the group', [$requests[1]['filter'], $requests[1]['vars']], [
    'dependency.child_service_name == "" && (dependency.parent_host_name in names || dependency.child_host_name in names)',
    ['names' => ['probe-a', 'probe-b']]
]);
check('only the neighbour outside the group is fetched by name', $requests[2]['vars'], ['names' => ['web-1']]);
check('services are fetched for every drawn host', $requests[3]['vars'], ['names' => ['probe-a', 'probe-b', 'web-1']]);
check('graph has the group hosts and their neighbour', $names, ['probe-a', 'probe-b', 'web-1']);
check('links from the dependencies', count($graph['links']), 2);
check('neighbour carries its service summary', $graph['nodes'][2]['services']['worst_unhandled'], 'critical');
check('group membership', array_column($graph['nodes'], 'member'), [true, true, false]);

// Several groups: hosts in any of them, all members
$requests = [];
$several = GraphSource::fetch(fakeApi(['hosts' => function ($body) {
    return strpos($body['filter'], '||') !== false
        ? [host('probe-a', ['groups' => ['web-checks']]), host('db-1', ['groups' => ['databases']])]
        : array_map('host', $body['filter_vars']['names']);
}] + $answers, $requests), ['web-checks', 'databases'], '/host?name=');
check('several groups: one host request for all of them', [$requests[0]['filter'], $requests[0]['vars']], [
    'group0 in host.groups || group1 in host.groups', ['group0' => 'web-checks', 'group1' => 'databases']
]);
check('several groups: members of each', array_column(array_filter($several['nodes'], function ($n) {
    return $n['member'];
}), 'name'), ['probe-a', 'db-1']);

// An empty group: one request, empty graph
$requests = [];
$empty = GraphSource::fetch(fakeApi(['hosts' => []] + $answers, $requests), 'nobody', '/host?name=');
check('empty group: only the group request is made', array_column($requests, 'kind'), ['hosts']);
check('empty group: empty graph', $empty, ['nodes' => [], 'links' => []]);

// No neighbours outside the group: no neighbour request
$requests = [];
GraphSource::fetch(fakeApi(['dependencies' => []] + $answers, $requests), 'web-checks', '/host?name=');
check('no neighbours: no neighbour request', array_column($requests, 'kind'), ['hosts', 'dependencies', 'services']);

// Services failing (e.g. no permission): graph without service details, error reported
$requests = [];
$reported = null;
$withoutServices = GraphSource::fetch(
    fakeApi(['services' => new \RuntimeException('403 Forbidden')] + $answers, $requests),
    'web-checks',
    '/host?name=',
    function ($e) use (&$reported) {
        $reported = $e->getMessage();
    }
);
check('services failing: still drawn', count($withoutServices['nodes']), 3);
check('services failing: marked unavailable', $withoutServices['nodes'][0]['services'], null);
check('services failing: error reported', $reported, '403 Forbidden');

// Dependencies between two drawn hosts outside the group (e.g. from a
// vars.parents apply rule between a DMZ host and a backend host)
$requests = [];
$dmz = [
    'hosts' => $answers['hosts'],
    'dependencies' => function ($body) {
        if (strpos($body['filter'], 'dependency.parent_host_name in names && dependency.child_host_name in names') !== false) {
            // Asked only about the hosts outside the group
            return [
                ['attrs' => ['parent_host_name' => 'dmz-1', 'child_host_name' => 'backend-1', 'child_service_name' => '']],
                ['attrs' => ['parent_host_name' => 'dmz-1', 'child_host_name' => 'elsewhere', 'child_service_name' => '']]
            ];
        }
        return [
            ['attrs' => ['parent_host_name' => 'probe-a', 'child_host_name' => 'dmz-1', 'child_service_name' => '']],
            ['attrs' => ['parent_host_name' => 'probe-b', 'child_host_name' => 'backend-1', 'child_service_name' => '']]
        ];
    },
    'services' => []
];
$graph = GraphSource::fetch(fakeApi($dmz, $requests), 'web-checks', '/host?name=');
check('outside links: an extra dependency request', array_column($requests, 'kind'),
    ['hosts', 'dependencies', 'hosts', 'dependencies', 'services']);
check('outside links: asked about the outside hosts only', $requests[3]['vars'], ['names' => ['dmz-1', 'backend-1']]);
check('outside links: the line between them is added', in_array(['source' => 'dmz-1', 'target' => 'backend-1'], $graph['links'], true), true);
check('outside links: no hosts are added', count($graph['nodes']), 4);

// A synthetic host outside the group (a neighbour): its members aren't drawn,
// but their states are fetched so its counts are complete
$requests = [];
$agg = GraphSource::fetch(fakeApi([
    'hosts' => function ($body) {
        if ($body['filter'] === 'group in host.groups') {
            return [host('probe-a', ['groups' => ['web-checks']])];
        }
        return array_map(function ($name) {
            $vars = $name === 'quorum-1'
                ? ['synthetic' => ['members' => ['w1', 'w2', 'w3'], 'parents' => [], 'mode' => 'quorum']] : [];
            return host($name, ['state' => $name === 'w3' ? 1 : 0, 'vars' => $vars]);
        }, $body['filter_vars']['names']);
    },
    'dependencies' => [
        ['attrs' => ['parent_host_name' => 'quorum-1', 'child_host_name' => 'probe-a', 'child_service_name' => '']]
    ],
    'services' => []
], $requests), 'web-checks', '/host?name=');
check('outside synthetic host: one more host request, for its members only', [array_column($requests, 'kind'), end($requests)['vars']],
    [['hosts', 'dependencies', 'hosts', 'services', 'hosts'], ['names' => ['w1', 'w2', 'w3']]]);
$q = array_values(array_filter($agg['nodes'], function ($n) {
    return $n['name'] === 'quorum-1';
}))[0];
check('outside synthetic host: members not drawn still count', [$q['aggregate']['up'], $q['aggregate']['down'], $q['aggregate']['needed']],
    [['w1', 'w2'], ['w3'], 2]);
check('outside synthetic host: its members are not added to the graph', array_column($agg['nodes'], 'name'), ['probe-a', 'quorum-1']);
check('vars are not sent to the page', array_key_exists('vars', $q), false);

// Members that aren't parents: drawn from vars.synthetic.members; a member
// Icinga doesn't know is left out
$requests = [];
$noParents = GraphSource::fetch(fakeApi([
    'hosts' => function ($body) {
        if ($body['filter'] === 'group in host.groups') {
            return [host('quorum-1', ['groups' => ['web-checks'], 'vars' => ['synthetic' => [
                'members' => ['w1', 'w2', 'ghost'], 'mode' => 'quorum'
            ]]])];
        }
        return array_map('host', array_values(array_diff($body['filter_vars']['names'], ['ghost'])));
    },
    'dependencies' => [],
    'services' => []
], $requests), 'web-checks', '/host?name=');
check('members without dependencies: fetched as neighbours', $requests[2]['vars'], ['names' => ['w1', 'w2', 'ghost']]);
check('members without dependencies: drawn and linked', [array_column($noParents['nodes'], 'name'), $noParents['links']], [
    ['quorum-1', 'w1', 'w2'],
    [['source' => 'w1', 'target' => 'quorum-1'], ['source' => 'w2', 'target' => 'quorum-1']]
]);
check('members without dependencies: unknown member counted, not drawn',
    $noParents['nodes'][0]['aggregate']['unknown'], ['ghost']);

// Hosts failing is an error for the caller
$thrown = null;
try {
    $requests = [];
    GraphSource::fetch(fakeApi(['hosts' => new \RuntimeException('connection refused')] + $answers, $requests), 'x', '/');
} catch (\RuntimeException $e) {
    $thrown = $e->getMessage();
}
check('hosts failing: passed on', $thrown, 'connection refused');

finish();
