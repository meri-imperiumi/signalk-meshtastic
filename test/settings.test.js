const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  environmentMetricsInterval,
  anchorRadiusPath,
  nodeRole,
  sendAlerts,
  statusPaths,
} = require('../plugin/settings');

describe('environment metrics interval', () => {
  it('defaults to off', () => {
    assert.equal(environmentMetricsInterval({}), 0);
    assert.equal(environmentMetricsInterval({ communications: {} }), 0);
  });

  it('handles a missing configuration', () => {
    assert.equal(environmentMetricsInterval(undefined), 0);
  });

  it('uses the configured interval', () => {
    assert.equal(environmentMetricsInterval({
      communications: { environment_metrics_interval: 900 },
    }), 900);
  });

  it('treats zero as disabled', () => {
    assert.equal(environmentMetricsInterval({
      communications: { environment_metrics_interval: 0 },
    }), 0);
  });

  it('keeps sending for configurations that enabled the old boolean', () => {
    assert.equal(environmentMetricsInterval({
      communications: { send_environment_metrics: true },
    }), 240);
  });

  it('keeps the old boolean turned off disabled', () => {
    assert.equal(environmentMetricsInterval({
      communications: { send_environment_metrics: false },
    }), 0);
  });

  it('prefers an explicit interval over the old boolean', () => {
    assert.equal(environmentMetricsInterval({
      communications: {
        send_environment_metrics: true,
        environment_metrics_interval: 0,
      },
    }), 0);
    assert.equal(environmentMetricsInterval({
      communications: {
        send_environment_metrics: false,
        environment_metrics_interval: 600,
      },
    }), 600);
  });

  it('ignores a non-numeric interval', () => {
    assert.equal(environmentMetricsInterval({
      communications: { environment_metrics_interval: 'often' },
    }), 0);
  });
});

describe('anchor radius path', () => {
  it('defaults to the distance from bow', () => {
    assert.equal(anchorRadiusPath({}), 'navigation.anchor.distanceFromBow');
  });

  it('uses the configured path', () => {
    assert.equal(anchorRadiusPath({
      communications: { anchor_radius_path: 'navigation.anchor.currentRadius' },
    }), 'navigation.anchor.currentRadius');
  });
});

describe('node role', () => {
  const settings = {
    nodes: [
      { node: 1234, role: 'crew' },
      { node: 5678, role: 'dinghy' },
    ],
  };

  it('returns the configured role for a node', () => {
    assert.equal(nodeRole(settings, 1234), 'crew');
    assert.equal(nodeRole(settings, 5678), 'dinghy');
  });

  it('returns undefined for unconfigured nodes', () => {
    assert.equal(nodeRole(settings, 9999), undefined);
    assert.equal(nodeRole({}, 1234), undefined);
    assert.equal(nodeRole(undefined, 1234), undefined);
  });
});

describe('send alerts', () => {
  it('is off unless enabled', () => {
    assert.equal(sendAlerts({}), false);
    assert.equal(sendAlerts({ communications: { send_alerts: false } }), false);
  });

  it('is on when enabled', () => {
    assert.equal(sendAlerts({ communications: { send_alerts: true } }), true);
  });
});

describe('status paths', () => {
  it('reports the house bank state of charge by default', () => {
    const soc = [{ path: 'electrical.batteries.house.capacity.stateOfCharge', label: 'SoC' }];
    assert.deepEqual(statusPaths({}), soc);
    assert.deepEqual(statusPaths({ communications: {} }), soc);
    assert.deepEqual(statusPaths({ communications: { status_paths: 'nope' } }), soc);
  });

  it('stays empty once the user has removed the defaults', () => {
    assert.deepEqual(statusPaths({ communications: { status_paths: [] } }), []);
  });

  it('returns the configured paths and labels', () => {
    assert.deepEqual(statusPaths({
      communications: {
        status_paths: [
          { path: 'networking.wan.activeLabel', label: 'WAN' },
          { path: 'networking.wan.state', label: 'Online' },
        ],
      },
    }), [
      { path: 'networking.wan.activeLabel', label: 'WAN' },
      { path: 'networking.wan.state', label: 'Online' },
    ]);
  });

  it('falls back to the path as label and skips entries without a path', () => {
    assert.deepEqual(statusPaths({
      communications: {
        status_paths: [
          { path: ' networking.wan.state ', label: '  ' },
          { label: 'Orphan' },
          { path: '' },
          null,
        ],
      },
    }), [
      { path: 'networking.wan.state', label: 'networking.wan.state' },
    ]);
  });
});
