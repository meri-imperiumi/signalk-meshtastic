const {
  anchorRadiusPath,
  nodeRole,
  sendAlerts,
  statusPaths,
} = require('../settings');

const RAD_TO_DEG = 180 / Math.PI;
const MS_TO_KN = 1.9438444924406046;
// Signal K keeps the last known value of a path around indefinitely, so measured
// values need an age check of their own to avoid reporting a dead sensor
const MAX_AGE_MS = 60000;
// Values that are set once and stay valid until changed
const NO_MAX_AGE = 0;
const WIND_PATH = 'environment.wind.speedTrue';
const MS_PER_UNIT = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60000,
  hours: 3600000,
};

// The history API wants the window as a Temporal.Duration, which Node does not
// have natively yet. Providers only ever ask a duration to convert itself, and
// accept either call signature, so implementing total() is enough and saves
// pulling in a polyfill. Passing the plain number the API also documents is not
// an option: it is specified as seconds, but the providers in the wild read it
// as milliseconds
function duration(milliseconds) {
  return {
    total: (unit) => {
      const name = typeof unit === 'string' ? unit : (unit || {}).unit;
      const perUnit = MS_PER_UNIT[name];
      if (!perUnit) {
        throw new RangeError(`Unsupported duration unit: ${name}`);
      }
      return milliseconds / perUnit;
    },
  };
}

const HISTORY_WINDOW = duration(10 * 60 * 1000);
// History buckets are aligned to the clock rather than to the query, so the
// bucket a window ends in is only partly filled. Asking for one second buckets
// sidesteps that: with wind arriving about once a second we get the samples
// themselves back, and can cut the windows we actually want out of them
const HISTORY_RESOLUTION = 1;
const RECENT_WINDOW_MS = 60000;

function selfValue(app, path, maxAge = MAX_AGE_MS) {
  const data = app.getSelfPath(path);
  if (data === null || data === undefined) {
    return undefined;
  }
  if (typeof data !== 'object' || !('value' in data)) {
    return data;
  }
  if (maxAge && data.timestamp) {
    const age = Date.now() - new Date(data.timestamp).getTime();
    if (Number.isFinite(age) && age > maxAge) {
      // Stale, better to report nothing than something wrong
      return undefined;
    }
  }
  return data.value;
}

function knots(value) {
  return (value * MS_TO_KN).toFixed(1);
}

function degrees(radians) {
  if (!Number.isFinite(radians)) {
    return undefined;
  }
  const deg = Math.round(radians * RAD_TO_DEG) % 360;
  return String(deg < 0 ? deg + 360 : deg).padStart(3, '0');
}

function anchorStatus(app, settings) {
  const position = selfValue(app, 'navigation.anchor.position', NO_MAX_AGE);
  if (!position || !Number.isFinite(position.latitude)) {
    return 'Anchor: not set';
  }
  const radius = selfValue(app, anchorRadiusPath(settings));
  const bearing = degrees(selfValue(app, 'navigation.anchor.bearingTrue'));
  const maxRadius = selfValue(app, 'navigation.anchor.maxRadius', NO_MAX_AGE);
  const parts = [
    Number.isFinite(radius) ? `${Math.round(radius)}m` : 'n/a',
  ];
  if (bearing) {
    parts.push(`${bearing}T`);
  }
  if (Number.isFinite(maxRadius)) {
    parts.push(`max ${Math.round(maxRadius)}m`);
  }
  return `Anchor: ${parts.join(' ')}`;
}

function depthStatus(app) {
  const depth = selfValue(app, 'environment.depth.belowSurface');
  if (!Number.isFinite(depth)) {
    return 'Depth: n/a';
  }
  return `Depth: ${depth.toFixed(1)}m`;
}

function windStatus(app) {
  const speed = selfValue(app, 'environment.wind.speedTrue');
  const direction = degrees(selfValue(app, 'environment.wind.directionTrue'));
  if (!Number.isFinite(speed) && !direction) {
    return 'Wind: n/a';
  }
  const parts = [
    Number.isFinite(speed) ? `${knots(speed)}kn` : 'n/a',
  ];
  if (direction) {
    parts.push(`${direction}T`);
  }
  return `Wind: ${parts.join(' ')}`;
}

// Node identities get reset, so confirm the asking node is still configured
// the way its owner expects. Only crew nodes receive anchor and other alerts
function nodeStatus(msg, settings) {
  const role = nodeRole(settings, msg.from);
  if (role !== 'crew') {
    return `Node: ${role || 'not configured'}, no alerts`;
  }
  return `Node: crew, alerts ${sendAlerts(settings) ? 'on' : 'off'}`;
}

function formatValue(value, units) {
  if (value === undefined || value === null || value === '') {
    return 'n/a';
  }
  if (typeof value === 'number') {
    if (units === 'ratio') {
      // Signal K keeps ratios as 0..1, but a state of charge reads better as a
      // percentage, and the reply has no room to spell the unit out
      return `${Math.round(value * 100)}%`;
    }
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

// Unit the server publishes for a path, when it publishes one at all
function pathUnits(app, path) {
  const data = app.getSelfPath(path);
  if (!data || typeof data !== 'object' || !data.meta) {
    return undefined;
  }
  return data.meta.units;
}

// Configured paths are typically state rather than sensor readings, like the
// active WAN connection, so they are reported regardless of age
//
// Paths with no value at all are left out rather than reported as unavailable:
// the defaults are not something the user asked for, and on a boat that does
// not measure them a line saying nothing is not worth the airtime
function configuredStatus(app, settings) {
  return statusPaths(settings)
    .map(({ path, label }) => {
      const value = selfValue(app, path, NO_MAX_AGE);
      if (value === undefined || value === null || value === '') {
        return undefined;
      }
      return `${label}: ${formatValue(value, pathUnits(app, path))}`;
    })
    .filter((line) => line);
}

function stats(rows) {
  if (!rows.length) {
    return undefined;
  }
  const averages = rows.map((row) => row[2]);
  return {
    average: averages.reduce((sum, value) => sum + value, 0) / averages.length,
    max: rows.reduce((prev, row) => (row[1] > prev ? row[1] : prev), rows[0][1]),
  };
}

function summarize(values) {
  // Rows are [timestamp, max, average], in the order the path specs were given
  const rows = values.data.filter((row) => Number.isFinite(row[1]) && Number.isFinite(row[2]));
  if (!rows.length) {
    return undefined;
  }
  const until = values.range && values.range.to
    ? new Date(values.range.to).getTime()
    : Date.now();
  const recent = rows.filter((row) => new Date(row[0]).getTime() >= until - RECENT_WINDOW_MS);
  return {
    tenMinutes: stats(rows),
    // Empty when the wind data stopped over a minute ago
    oneMinute: stats(recent),
  };
}

function windHistory(app) {
  if (typeof app.getHistoryApi !== 'function') {
    // Signal K server without the history API
    return Promise.resolve(undefined);
  }
  return app.getHistoryApi()
    .then((history) => history.getValues({
      context: app.selfContext || 'vessels.self',
      duration: HISTORY_WINDOW,
      resolution: HISTORY_RESOLUTION,
      pathSpecs: [
        { path: WIND_PATH, aggregate: 'max', parameter: [] },
        { path: WIND_PATH, aggregate: 'average', parameter: [] },
      ],
    }))
    .then((values) => summarize(values))
    // No history provider configured, or the query failed. Report what we have
    .catch(() => undefined);
}

module.exports = {
  crewOnly: false,
  example: 'Status',
  accept: (msg) => (msg.data.toLowerCase() === 'status'),
  handle: (msg, settings, device, app) => windHistory(app)
    .then((history) => {
      const status = [
        anchorStatus(app, settings),
        depthStatus(app),
        windStatus(app),
      ];
      if (history && history.oneMinute) {
        status.push(`Wind 1m: avg ${knots(history.oneMinute.average)} max ${knots(history.oneMinute.max)}kn`);
      }
      if (history) {
        status.push(`Wind 10m: avg ${knots(history.tenMinutes.average)} max ${knots(history.tenMinutes.max)}kn`);
      }
      status.push(...configuredStatus(app, settings));
      status.push(nodeStatus(msg, settings));
      return device.sendText(status.join('\n'), msg.from, true, false);
    }),
};
