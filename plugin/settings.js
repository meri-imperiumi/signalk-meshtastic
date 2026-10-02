// Resolving configuration values needs a home of its own now that several of
// them are read from more than one place
const DEFAULT_ANCHOR_RADIUS_PATH = 'navigation.anchor.distanceFromBow';
// State of charge of the house bank, the same bank the environment metrics
// report voltage and current for. Reported in the status reply unless the user
// takes it out of the configured paths
const DEFAULT_STATUS_PATHS = [
  { path: 'electrical.batteries.house.capacity.stateOfCharge', label: 'SoC' },
];

function communications(settings) {
  return (settings && settings.communications) || {};
}

// Signal K path holding the distance to the anchor
function anchorRadiusPath(settings) {
  return communications(settings).anchor_radius_path || DEFAULT_ANCHOR_RADIUS_PATH;
}

// Role ('crew', 'dinghy', 'onboard') this node has been given in the plugin
// configuration, or undefined for nodes we know nothing about
function nodeRole(settings, nodeNum) {
  const nodes = (settings && settings.nodes) || [];
  const configured = nodes.find((node) => node.node === nodeNum);
  return configured ? configured.role : undefined;
}

function sendAlerts(settings) {
  return Boolean(communications(settings).send_alerts);
}

// Extra Signal K paths to report in the status reply, each with the label to
// show it under. Entries without a path are skipped, a missing label falls
// back to the path itself
//
// A configuration that has never been saved falls back to the defaults, while
// an empty list is left empty: the user took the default entries out and should
// not get them handed back
function statusPaths(settings) {
  const configured = communications(settings).status_paths;
  if (!Array.isArray(configured)) {
    return DEFAULT_STATUS_PATHS;
  }
  return configured
    .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim())
    .map((entry) => ({
      path: entry.path.trim(),
      label: (typeof entry.label === 'string' && entry.label.trim()) || entry.path.trim(),
    }));
}

module.exports = {
  anchorRadiusPath,
  nodeRole,
  sendAlerts,
  statusPaths,
  DEFAULT_STATUS_PATHS,
};
