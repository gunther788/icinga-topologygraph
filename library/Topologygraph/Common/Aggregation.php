<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * Synthetic hosts as python-icinga2-aggregator sees them
 * (https://github.com/gunther788/python-icinga2-aggregator):
 *
 *     vars.synthetic = {
 *       members = [ "web-1", "web-2" ]      host names (a "host!service" member: its host)
 *       member_groups = [ "web-servers" ]   adds the hosts of these host groups
 *       mode = "quorum"                     "all", "any" or "quorum" ("unknown": not configured)
 *       quorum = "66%"                      a count, a percentage (rounded up), or a majority
 *       sources = "best"                    "best", "worst", "majority" or "home"
 *     }
 *
 * Host objects with the same vars.real_host (a host without it stands for
 * itself) are the *sources* of one member, e.g. the same machine checked from
 * several zones: counts are per real host, and the sources are combined with
 * the `sources` policy.
 *
 * The aggregator writes its result to the synthetic host's "health" service,
 * with perfdata healthy=<n>;;<required>:;0;<total>. When that is there, its
 * counts are used as they are; otherwise they are worked out here from the
 * host states of the sources, by the same rules.
 */
final class Aggregation
{
    const VAR_NAME = 'synthetic';
    const REAL_HOST = 'real_host';
    const HOME = 'home';
    const HEALTH_SERVICE = 'health';

    /**
     * The aggregation configured on a host, or null
     *
     * @param array|null $attrs Host attributes (with vars)
     *
     * @return array|null ['members', 'member_groups', 'mode', 'quorum', 'sources']
     */
    public static function config($attrs)
    {
        $vars = $attrs['vars'][self::VAR_NAME] ?? null;
        if (! is_array($vars)) {
            return null;
        }
        $members = [];
        foreach ((array) ($vars['members'] ?? []) as $member) {
            // A "host!service" member is drawn as its host
            $host = explode('!', (string) $member, 2)[0];
            if ($host !== '') {
                $members[$host] = true;
            }
        }
        $groups = array_values(array_filter(array_map('strval', (array) ($vars['member_groups'] ?? [])), 'strlen'));
        $mode = strtolower(trim((string) ($vars['mode'] ?? 'all')));
        if ((! $members && ! $groups) || $mode === 'unknown' || $mode === '') {
            return null; // not configured (the defaults of the synthetic-host template)
        }

        return [
            'members'       => array_map('strval', array_keys($members)),
            'member_groups' => $groups,
            'mode'          => $mode,
            'quorum'        => $vars['quorum'] ?? null,
            'sources'       => strtolower(trim((string) ($vars['sources'] ?? 'best'))) ?: 'best'
        ];
    }

    /** The real host behind a host object: its vars.real_host, else its name */
    public static function realHost($name, $attrs)
    {
        $real = $attrs['vars'][self::REAL_HOST] ?? null;

        return is_string($real) && $real !== '' ? $real : (string) $name;
    }

    /**
     * Members needed for the mode, as the aggregator resolves them
     *
     * @return int|null Null for a mode or quorum this module doesn't understand
     */
    public static function needed($mode, $quorum, $total)
    {
        if ($mode === 'all') {
            return $total;
        }
        if ($mode === 'any') {
            return $total ? 1 : 0;
        }
        if (ctype_digit($mode)) {
            return min($total, (int) $mode); // a number as the mode (older configs)
        }
        if ($mode !== 'quorum') {
            return null;
        }
        if ($quorum === null || $quorum === '') {
            return intdiv($total, 2) + 1;
        }
        if (is_string($quorum) && preg_match('/^\s*(\d+(?:\.\d+)?)\s*%\s*$/', $quorum, $match)) {
            return max(1, (int) ceil(round((float) $match[1] * $total / 100, 9)));
        }
        if (is_int($quorum) || is_float($quorum) || (is_string($quorum) && ctype_digit(trim($quorum)))) {
            return max(1, min($total, (int) $quorum));
        }

        return null;
    }

    /**
     * The host names a synthetic host's members are drawn as: every source of
     * every member
     *
     * @param array $config      From config()
     * @param array $hosts       Attributes of the hosts known, by name (members and their sources)
     * @param array $groupHosts  Host names per host group, for member_groups
     * @param string $self       The synthetic host's name (never its own member)
     *
     * @return array [real host => [source host names]] in member order
     */
    public static function sources(array $config, array $hosts, array $groupHosts, $self)
    {
        $listed = $config['members'];
        foreach ($config['member_groups'] as $group) {
            foreach ($groupHosts[$group] ?? [] as $name) {
                $listed[] = (string) $name;
            }
        }
        $byReal = [];
        foreach ($hosts as $name => $attrs) {
            $byReal[self::realHost($name, $attrs)][] = (string) $name;
        }

        $sources = [];
        foreach ($listed as $member) {
            if ($member === $self) {
                continue;
            }
            $real = isset($hosts[$member]) ? self::realHost($member, $hosts[$member]) : $member;
            if (isset($sources[$real])) {
                continue;
            }
            $names = $byReal[$real] ?? [];
            sort($names, SORT_STRING);
            $sources[$real] = array_values(array_diff($names, [$self]));
        }

        return $sources;
    }

    /**
     * A synthetic host's aggregation for the page
     *
     * @param string     $name       The synthetic host
     * @param array      $config     From config()
     * @param array      $hosts      Attributes of the hosts known, by name
     * @param array      $groupHosts Host names per host group, for member_groups
     * @param array|null $health     Its health service's last_check_result, if any
     *
     * @return array
     */
    public static function summary($name, array $config, array $hosts, array $groupHosts, $health = null)
    {
        $sources = self::sources($config, $hosts, $groupHosts, $name);
        $up = $down = $unknown = [];
        $members = [];
        $multiple = false;
        foreach ($sources as $real => $names) {
            $members = array_merge($members, $names);
            $multiple = $multiple || count($names) > 1;
            $state = self::combine($real, $names, $hosts, $config['sources']);
            if ($state === 'up') {
                $up[] = $real;
            } elseif ($state === 'down') {
                $down[] = $real;
            } else {
                $unknown[] = $real;
            }
        }
        $total = count($sources);
        $summary = [
            'mode'    => $config['mode'],
            'needed'  => self::needed($config['mode'], $config['quorum'], $total),
            'total'   => $total,
            'healthy' => count($up),
            // Every source of every member, as drawn
            'members' => array_values(array_unique($members)),
            'sources' => $multiple ? $config['sources'] : null,
            'up'      => $up,
            'down'    => $down,
            'unknown' => $unknown,
            'from'    => 'graph',
            'result'  => null
        ];

        // The aggregator's own result wins
        $perfdata = self::healthyPerfdata($health['performance_data'] ?? null);
        if ($perfdata !== null) {
            $summary['healthy'] = $perfdata['healthy'];
            $summary['needed'] = $perfdata['needed'];
            $summary['total'] = $perfdata['total'];
            $summary['from'] = 'aggregator';
        }
        if (! empty($health['output'])) {
            $summary['result'] = strtok((string) $health['output'], "\n");
        }

        return $summary;
    }

    /**
     * A member's state from its sources' host states, by the sources policy.
     * Sources without a check result (or unknown to Icinga) are left out.
     *
     * @return string up, down or unknown
     */
    public static function combine($real, array $names, array $hosts, $policy)
    {
        $checked = [];
        foreach ($names as $name) {
            $attrs = $hosts[$name] ?? null;
            if ($attrs === null || ! isset($attrs['state']) || ($attrs['last_check'] ?? 0) <= 0) {
                continue;
            }
            $checked[$name] = ((int) $attrs['state']) === 0;
        }
        if (! $checked) {
            return 'unknown';
        }
        $ups = count(array_filter($checked));
        if ($policy === 'home') {
            $home = self::home($real, array_keys($checked), $hosts);
            if ($home !== null) {
                return $checked[$home] ? 'up' : 'down';
            }
            $policy = 'best';
        }
        if ($policy === 'worst') {
            $isUp = $ups === count($checked);
        } elseif ($policy === 'majority') {
            $isUp = $ups > intdiv(count($checked), 2);
        } else {
            $isUp = $ups > 0; // best
        }

        return $isUp ? 'up' : 'down';
    }

    /** The home object among checked sources: vars.home = true, else the one named like the real host */
    private static function home($real, array $checked, array $hosts)
    {
        $marked = array_values(array_filter($checked, function ($name) use ($hosts) {
            return ($hosts[$name]['vars'][self::HOME] ?? null) === true;
        }));
        sort($marked, SORT_STRING);
        if ($marked) {
            return $marked[0];
        }

        return in_array($real, $checked, true) ? $real : null;
    }

    /**
     * healthy=<n>;;<required>:;0;<total> from the aggregator's perfdata
     *
     * @param array|string|null $perfdata
     *
     * @return array|null ['healthy', 'needed', 'total']
     */
    public static function healthyPerfdata($perfdata)
    {
        foreach ((array) $perfdata as $line) {
            foreach (preg_split('/\s+/', trim((string) $line)) as $item) {
                if (preg_match("/^'?healthy'?=(\d+)[^;]*;[^;]*;(\d+):?;[^;]*;(\d+)/", $item, $m)) {
                    return ['healthy' => (int) $m[1], 'needed' => (int) $m[2], 'total' => (int) $m[3]];
                }
            }
        }

        return null;
    }
}
