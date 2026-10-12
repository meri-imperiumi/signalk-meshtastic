// Resolving configuration values needs a home of its own now that several of
// them are read from more than one place
const DEFAULT_ANCHOR_RADIUS_PATH = 'navigation.anchor.distanceFromBow';
// How often environment metrics go out, in seconds, for configurations that
// enabled them through the boolean this setting replaced
const DEFAULT_METRICS_INTERVAL = 240;
// State of charge of the house bank, the same bank the environment metrics
// report voltage and current for. Reported in the status reply unless the user
// takes it out of the configured paths. The energy predictor's overall outlook
// is appended to this same line
const HOUSE_SOC_PATH = 'electrical.batteries.house.capacity.stateOfCharge';
const DEFAULT_STATUS_PATHS = [
  { path: HOUSE_SOC_PATH, label: 'SoC' },
];

function communications(settings) {
  return (settings && settings.communications) || {};
}

// Seconds between environment metric broadcasts, or 0 to send none. Defaults
// to off, as the boolean this setting replaced did
function environmentMetricsInterval(settings) {
  const options = communications(settings);
  if (Number.isFinite(options.environment_metrics_interval)) {
    return options.environment_metrics_interval;
  }
  if (options.send_environment_metrics === true) {
    // Migrating a configuration that enabled the boolean this setting
    // replaced, which sent metrics every four minutes
    return DEFAULT_METRICS_INTERVAL;
  }
  return 0;
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

// Meshtastic channel index the plugin's broadcasts — environment metrics and
// MOB waypoints — are sent on. Channel 0 is the primary channel every node
// shares; a boat that keeps its telemetry on a secondary channel points this
// at that channel's index instead
//
// Direct messages need no channel choice: they are encrypted for the
// recipient rather than with the channel key, so command replies simply
// travel on the channel the command arrived from
function broadcastChannel(settings) {
  const channel = communications(settings).broadcast_channel;
  if (Number.isInteger(channel) && channel >= 0 && channel <= 7) {
    return channel;
  }
  return 0;
}

// Whether commands must arrive in cryptographically verified packets to be
// executed. A packet counts as verified when the boat node's firmware
// validated its signature (Meshtastic 2.8), or when it was PKI-encrypted with
// the recipient's public key, so only the node holding the key bound to the
// claimed sender number could have produced it (Meshtastic 2.5). Unverified
// packets may carry a forged sender number; with this on, commands in them
// are refused
function requireSignedCommands(settings) {
  return Boolean(communications(settings).require_signed_commands);
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
  environmentMetricsInterval,
  anchorRadiusPath,
  nodeRole,
  sendAlerts,
  statusPaths,
  broadcastChannel,
  requireSignedCommands,
  DEFAULT_STATUS_PATHS,
  HOUSE_SOC_PATH,
};
