const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  migrateIdentity,
  nodeIdHistory,
  publicKeyOf,
  previousIdentity,
  staleRoles,
} = require('../plugin/identity');

// The node database stores public keys base64-encoded, the same format
// publicKeyOf produces from the raw bytes on the wire
function userWithKey(rawKey) {
  return { publicKey: rawKey, longName: 'New name', shortName: 'NN' };
}

// JSON snapshot of the nodes map, with dates kept comparable
function snapshot(nodes) {
  return JSON.stringify(
    nodes,
    (key, value) => (value instanceof Date ? value.toISOString() : value),
  );
}

describe('publicKeyOf', () => {
  it('encodes raw key bytes as base64', () => {
    const raw = Buffer.from('boat-key');
    assert.equal(publicKeyOf({ publicKey: raw }), raw.toString('base64'));
  });

  it('returns nothing without a key', () => {
    assert.equal(publicKeyOf(undefined), undefined);
    assert.equal(publicKeyOf({}), undefined);
  });
});

describe('previousIdentity', () => {
  const raw = Buffer.from('boat-key');
  const nodes = {
    111: { publicKey: raw.toString('base64') },
    222: { publicKey: Buffer.from('other').toString('base64') },
  };

  it('finds the entry carrying the same public key under another number', () => {
    assert.equal(previousIdentity(nodes, raw.toString('base64'), 222), 111);
  });

  it('finds nothing when the key is new', () => {
    assert.equal(previousIdentity(nodes, Buffer.from('unknown').toString('base64'), 222), undefined);
  });

  it('finds nothing when the same number carries the key', () => {
    assert.equal(previousIdentity(nodes, raw.toString('base64'), 111), undefined);
  });
});

describe('nodeIdHistory', () => {
  it('returns stored past numbers', () => {
    assert.deepEqual(nodeIdHistory({ nodeIds: [111, 222] }), [111, 222]);
  });

  it('returns nothing without a stored history', () => {
    assert.deepEqual(nodeIdHistory({}), []);
    assert.deepEqual(nodeIdHistory(undefined), []);
  });
});

describe('migrateIdentity', () => {
  const raw = Buffer.from('boat-key');
  const base64Key = raw.toString('base64');

  function nodesWithOldNumber() {
    return {
      111: {
        publicKey: base64Key,
        longName: 'Bergie DE OH2XYZ',
        shortName: 'BG',
        mmsi: '98111',
        seen: new Date('2026-10-01T10:00:00Z'),
      },
      222: { publicKey: Buffer.from('other').toString('base64') },
    };
  }

  it('carries identity and vessel association to the new number', () => {
    const nodes = nodesWithOldNumber();
    const result = migrateIdentity(nodes, {
      num: 333,
      user: userWithKey(raw),
    });
    assert.deepEqual(result, { oldNum: 111, newNum: 333 });
    // Identity carried over
    assert.equal(nodes[333].longName, 'Bergie DE OH2XYZ');
    assert.equal(nodes[333].shortName, 'BG');
    assert.equal(nodes[333].mmsi, '98111');
    assert.equal(nodes[333].publicKey, base64Key);
    assert.equal(nodes[333].seen.toISOString(), '2026-10-01T10:00:00.000Z');
    // Old number pruned and recorded in the history, unrelated nodes left alone
    assert.equal(nodes[111], undefined);
    assert.deepEqual(nodeIdHistory(nodes[333]), [111]);
    assert.ok(nodes[222]);
  });

  it('accumulates history over successive migrations', () => {
    let nodes = nodesWithOldNumber();
    migrateIdentity(nodes, { num: 333, user: userWithKey(raw) });
    // A second upgrade: the node re-keys again from 333 to 444
    nodes = {
      333: nodes[333],
    };
    migrateIdentity(nodes, { num: 444, user: userWithKey(raw) });
    assert.deepEqual(nodeIdHistory(nodes[444]), [111, 333]);
  });

  it('ignores the stale old entry the boat node replays on reconnect', () => {
    const nodes = nodesWithOldNumber();
    migrateIdentity(nodes, { num: 333, user: userWithKey(raw) });
    assert.deepEqual(nodeIdHistory(nodes[333]), [111]);
    // The boat node still has 111 in its own database and replays it on the
    // next reconnect, with the last-heard time from before the upgrade
    const echoed = migrateIdentity(nodes, {
      num: 111,
      user: userWithKey(raw),
      lastHeard: Math.floor(new Date('2026-10-01T10:00:00Z').getTime() / 1000),
    });
    assert.equal(echoed, null);
    assert.deepEqual(nodeIdHistory(nodes[333]), [111]);
    // The echo entry the handler creates is folded back into the current
    // identity when its fresh NodeInfo arrives
    nodes[111] = { publicKey: base64Key, seen: new Date('2026-10-01T10:00:00Z') };
    migrateIdentity(nodes, {
      num: 333,
      user: userWithKey(raw),
      lastHeard: Math.floor(new Date('2026-10-02T10:00:00Z').getTime() / 1000),
    });
    assert.equal(nodes[111], undefined);
    assert.deepEqual(nodeIdHistory(nodes[333]), [111]);
    // Migration keeps the newest seen of the two; the handler then overwrites
    // it with the fresh lastHeard of the arriving NodeInfo either way
    assert.equal(nodes[333].seen.toISOString(), '2026-10-01T10:00:00.000Z');
  });

  it('migrates back when a node returns to a previous number', () => {
    // A downgrade from 2.8 to 2.7 restores the pre-2.8 number
    const nodes = {
      333: {
        publicKey: base64Key,
        nodeIds: [111],
        seen: new Date('2026-10-01T10:00:00Z'),
      },
    };
    migrateIdentity(nodes, {
      num: 111,
      user: userWithKey(raw),
      lastHeard: Math.floor(new Date('2026-10-02T10:00:00Z').getTime() / 1000),
    });
    assert.equal(nodes[333], undefined);
    assert.deepEqual(nodeIdHistory(nodes[111]), [333]);
  });

  it('never moves the thisNode flag', () => {
    const nodes = nodesWithOldNumber();
    nodes[111].thisNode = true;
    migrateIdentity(nodes, { num: 333, user: userWithKey(raw) }, {});
    assert.equal(nodes[333].thisNode, undefined);
  });

  it('keeps the newest seen timestamp of the two entries', () => {
    const nodes = nodesWithOldNumber();
    nodes[333] = { seen: new Date('2026-10-02T10:00:00Z') };
    migrateIdentity(nodes, { num: 333, user: userWithKey(raw) }, {});
    assert.equal(nodes[333].seen.toISOString(), '2026-10-02T10:00:00.000Z');

    const nodes2 = nodesWithOldNumber();
    nodes2[333] = { seen: new Date('2026-09-01T10:00:00Z') };
    migrateIdentity(nodes2, { num: 333, user: userWithKey(raw) }, {});
    assert.equal(nodes2[333].seen.toISOString(), '2026-10-01T10:00:00.000Z');
  });

  it('reports configured roles instead of remapping them', () => {
    const nodes = nodesWithOldNumber();
    const settings = {
      nodes: [
        { node: 111, role: 'crew', name: 'Bergie' },
        { node: 222, role: 'dinghy' },
      ],
    };
    migrateIdentity(nodes, {
      num: 333,
      user: userWithKey(raw),
    });
    const stale = staleRoles(nodes[333], settings);
    assert.deepEqual(stale, [{ node: 111, role: 'crew', name: 'Bergie' }]);
    // Nothing was remapped or persisted
    assert.deepEqual(settings.nodes[0], { node: 111, role: 'crew', name: 'Bergie' });
    assert.equal(settings.nodes[1].node, 222);
    // Once the admin reassigns the role, nothing is stale anymore
    settings.nodes[0].node = 333;
    assert.deepEqual(staleRoles(nodes[333], settings), []);
  });

  it('finds nothing to migrate for a genuinely new node', () => {
    const nodes = nodesWithOldNumber();
    const before = snapshot(nodes);
    const result = migrateIdentity(nodes, {
      num: 333,
      user: userWithKey(Buffer.from('new-key')),
    }, {});
    assert.equal(result, null);
    assert.equal(snapshot(nodes), before);
  });

  it('finds nothing to migrate without a public key', () => {
    const nodes = nodesWithOldNumber();
    const result = migrateIdentity(nodes, { num: 333, user: { longName: 'X' } }, {});
    assert.equal(result, null);
    assert.ok(nodes[111]);
  });

  it('works when the node database has no entry for the old number', () => {
    const nodes = {};
    const result = migrateIdentity(nodes, { num: 333, user: userWithKey(raw) }, {});
    assert.equal(result, null);
    assert.equal(nodes[333], undefined);
  });
});
