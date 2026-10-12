// Node identity migration for Meshtastic 2.8
//
// Meshtastic 2.8 derives a node's number from its public key, so flashing a
// node with 2.8 changes its number: other nodes see a new node while the old
// entry lingers in their lists until it ages out.
//
// The node database stores each node's public key exactly once (plugin
// index.js, "to prevent spoofing"). A public key re-appearing under a new
// number therefore identifies the same physical node, and we migrate what is
// safe to migrate automatically: the names, the vessel association and the
// last-seen time move to the new number, the old number is recorded in the
// entry's history and pruned from the database.
//
// What does NOT move automatically is privilege. The evidence for a
// migration is a NodeInfo packet, and on boat nodes before 2.8 those carry no
// authenticity at all: an attacker on a shared channel can broadcast a
// NodeInfo pairing the crew node's public key (public by design) with a
// number they control. Command authorization keys on node numbers, and
// switching commands operate real-world circuits, so re-binding a crew role
// on unverified evidence would let one forged packet hand the attacker a
// permanent, reboot-surviving crew role. Instead the migration reports the
// configured roles still pointing at the old number, and the caller notifies
// the admin to reassign them — by hand, through the plugin configuration.

// Public keys travel as raw bytes on the wire and are stored base64-encoded
// in the node database. Normalize both sides to base64 for comparison
function publicKeyOf(user) {
  if (!user || !user.publicKey) {
    return undefined;
  }
  try {
    return Buffer.from(user.publicKey).toString('base64');
  } catch (e) {
    return undefined;
  }
}

// Find the node database entry that carried this public key under a
// different number, if any
function previousIdentity(nodes, publicKey, newNum) {
  const oldNum = Object.keys(nodes).find((num) => {
    const node = nodes[num];
    return node
      && node.publicKey === publicKey
      && Number(num) !== Number(newNum);
  });
  return oldNum === undefined ? undefined : Number(oldNum);
}

// Every number a node has been known under, oldest first. The current
// number is the key the entry lives at in the database, so only past
// numbers are stored
function nodeIdHistory(entry) {
  if (!entry || !Array.isArray(entry.nodeIds)) {
    return [];
  }
  return entry.nodeIds.filter((id) => Number.isInteger(id));
}

// Migrate a re-keyed node's identity: carry names, vessel association and
// last-seen time over to the new number, record the old number in the
// entry's history and prune it from the database. Configured roles are left
// pointing at the old number — reassigning them is the admin's call, made in
// the plugin configuration — and the thisNode flag never moves: the boat
// node announces its own identity over the local connection through
// onMyNodeInfo, which mesh traffic cannot forge
//
// Returns the migration, or null when there was nothing to migrate
function migrateIdentity(nodes, nodeInfo) {
  const publicKey = publicKeyOf(nodeInfo.user);
  if (!publicKey || nodeInfo.num === undefined || nodeInfo.num === null) {
    return null;
  }
  const oldNum = previousIdentity(nodes, publicKey, nodeInfo.num);
  if (oldNum === undefined) {
    return null;
  }
  const previous = nodes[String(oldNum)];
  // The boat node keeps a re-keyed node's old entry in its own database
  // until it ages out, and replays it in the node dump on every reconnect.
  // Migrating on that stale echo would bounce the identity back to the dead
  // number and forth again on each restart. Only a NodeInfo newer than the
  // identity's last-seen time is evidence the node actually moved: a node
  // cannot transmit as two numbers at once, so the newer of the two numbers
  // is the one it lives on
  const arrived = nodeInfo.lastHeard
    ? new Date(nodeInfo.lastHeard * 1000)
    : new Date();
  if (previous.seen && arrived <= previous.seen) {
    return null;
  }
  if (!nodes[nodeInfo.num]) {
    // eslint-disable-next-line no-param-reassign
    nodes[nodeInfo.num] = {};
  }
  const entry = nodes[nodeInfo.num];
  entry.publicKey = entry.publicKey || previous.publicKey;
  entry.longName = entry.longName || previous.longName;
  entry.shortName = entry.shortName || previous.shortName;
  // Keep the vessel association stable, so a re-keyed node does not appear
  // as a brand new vessel in Signal K
  entry.mmsi = entry.mmsi || previous.mmsi;
  if (previous.seen && (!entry.seen || previous.seen > entry.seen)) {
    entry.seen = previous.seen;
  }
  // Record every number this identity has lived under, oldest first, so a
  // node that re-keys repeatedly (or is downgraded and upgraded again)
  // keeps a readable trail. The current number is the key the entry lives
  // at in the database and is never part of its own history
  entry.nodeIds = [...new Set([
    ...nodeIdHistory(previous),
    oldNum,
    ...nodeIdHistory(entry),
  ])].filter((id) => id !== nodeInfo.num);
  // The new number overrides the old one: prune it now instead of keeping a
  // duplicate that would only pollute the node database and the Signal K
  // tree until it aged out on its own
  // eslint-disable-next-line no-param-reassign
  delete nodes[String(oldNum)];
  return { oldNum, newNum: nodeInfo.num };
}

// Configured roles still pointing at numbers this node has been known under.
// After a re-key every such role is stale — the old number no longer exists
// on the mesh — and the admin needs to reassign it. Computed from the id
// history rather than tracked at migration time, so the answer stays current
// as the configuration changes
function staleRoles(entry, settings) {
  const past = nodeIdHistory(entry);
  if (!past.length) {
    return [];
  }
  return ((settings && settings.nodes) || [])
    .filter((configuredNode) => configuredNode
      && past.indexOf(Number(configuredNode.node)) !== -1);
}

module.exports = {
  migrateIdentity,
  nodeIdHistory,
  publicKeyOf,
  previousIdentity,
  staleRoles,
};
