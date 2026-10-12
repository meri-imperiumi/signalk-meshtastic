const { readFile, writeFile } = require('fs/promises');
const { join } = require('path');

const Telemetry = require('./telemetry');
const commands = require('./commands/index');
const { migrateIdentity, nodeIdHistory, staleRoles } = require('./identity');
const { nodeCanVerify, isVerified } = require('./verification');
const { hasValidPosition, truncationRadius } = require('./precision');
const { sendMOB } = require('./waypoint');
const { sendNotification, sweepNotifications } = require('./notifications');
const {
  environmentMetricsInterval,
  anchorRadiusPath,
  DEFAULT_STATUS_PATHS,
  broadcastChannel,
  requireSignedCommands,
} = require('./settings');

if (!global.crypto) {
  // Older Node.js versions (like the one bundled in Venus OS
  // don't have crypto module available
  // eslint-disable-next-line global-require
  global.crypto = require('node:crypto');
}

// The ES modules we'll need to import
let MeshDevice;
let TransportHTTP;
let TransportNode;
let create;
let toBinary;
let Protobuf;

// Keep a map of ongoing notification episodes
const episodes = new Map();

function getNodeContext(app, node, nodeNum, settings) {
  if (node.thisNode) {
    return 'vessels.self';
  }
  if (settings.nodes && settings.nodes.length && settings.nodes
    .find((settingNode) => {
      if (settingNode.node !== nodeNum) {
        return false;
      }
      if (settingNode.role !== 'onboard') {
        return false;
      }
      return true;
    })) {
    // Onboard equipment
    return 'vessels.self';
  }
  // Create context for other nodes
  // Associate nodes with AIS vessels if callsign available
  if (!app.signalk.root.vessels) {
    return null;
  }
  if (!node.longName) {
    return null;
  }
  // Match the "Some node name DE CALLSIGN" pattern
  const matched = node.longName.match(/.* DE ([A-Z0-9]{4,})$/);
  if (matched && matched[1]) {
    if (node.mmsi) {
      // We've already associated this node with an MMSI so no need for lookup
      return `vessels.urn:mrn:imo:mmsi:${node.mmsi}`;
    }
    const callsignPath = Object.keys(app.signalk.root.vessels)
      .find((vesselCtx) => {
        const vessel = app.signalk.root.vessels[vesselCtx];
        if (!vessel.communication || !vessel.communication.callsignVhf) {
          return false;
        }
        if (vessel.communication.callsignVhf === matched[1]) {
          return true;
        }
        return false;
      });
    if (callsignPath) {
      return `vessels.${callsignPath}`;
    }
    return null;
  }
  if (!nodeNum) {
    return null;
  }
  if (settings && settings.communications && settings.communications.populate_vessels) {
    // 98 MMSI prefix is for craft associated with a parent ship
    // TODO: Add MID (country code of parent ship
    return `vessels.urn:mrn:imo:mmsi:98${nodeNum}`;
  }
  // Make vessels/other targets for non-boat nodes
  return `meshtastic.urn:meshtastic:node:${nodeNum}`;
}

function nodeToSignalK(app, node, nodeInfo, settings) {
  const context = getNodeContext(app, node, nodeInfo.num, settings);
  if (!context || (context === 'vessels.self' && !node.thisNode)) {
    return undefined;
  }
  const values = [
    {
      path: 'communication.meshtastic.nodeNum',
      value: nodeInfo.num,
    },
    {
      path: 'communication.meshtastic.shortName',
      value: nodeInfo.user.shortName,
    },
    {
      path: 'communication.meshtastic.longName',
      value: nodeInfo.user.longName,
    },
  ];

  if (hasValidPosition(nodeInfo.position)) {
    values.push({
      path: 'navigation.position',
      value: {
        latitude: nodeInfo.position.latitudeI * 1e-7,
        longitude: nodeInfo.position.longitudeI * 1e-7,
      },
    });
  }

  let role = 'client';
  switch (nodeInfo.user.role) {
    case 1: {
      role = 'client_mute';
      break;
    }
    case 2: {
      role = 'router';
      break;
    }
    case 3: {
      role = 'router_client';
      break;
    }
    case 4: {
      role = 'repeater';
      break;
    }
    case 5: {
      role = 'tracker';
      break;
    }
    case 6: {
      role = 'sensor';
      break;
    }
    case 7: {
      role = 'tak';
      break;
    }
    case 8: {
      role = 'client_hidden';
      break;
    }
    case 9: {
      role = 'lost_and_found';
      break;
    }
    case 10: {
      role = 'tak_tracker';
      break;
    }
    case 11: {
      role = 'router_late';
      break;
    }
    case 12: {
      role = 'client_base';
      break;
    }
    default: {
      break;
    }
  }
  values.push({
    path: 'communication.meshtastic.role',
    value: role,
  });

  if (context.indexOf('meshtastic.urn') === 0
    || (context.indexOf('vessels.urn') === 0
      && context.indexOf(':98') !== -1)) {
    // This is a purely Meshtastic node so we inject additional data to "vesselify" it
    values.push({
      path: '',
      value: {
        name: nodeInfo.user.longName,
      },
    });
    if (settings && settings.communications && settings.communications.populate_vessels) {
      values.push({
        path: '',
        value: {
          mmsi: context.split(':').at(-1),
        },
      });
    }
    // TODO: Type for dinghy, crew, etc
  }

  app.handleMessage('signalk-meshtastic', {
    context,
    updates: [
      {
        source: {
          label: 'signalk-meshtastic',
          src: String(nodeInfo.num),
        },
        timestamp: new Date().toISOString(),
        values,
      },
    ],
  });

  return context;
}

module.exports = (app) => {
  const plugin = {};
  let device;
  let watchdog;
  let watchdogTriggered = 0;
  // Pending retry timers that must not outlive a stop()
  let startupRetry;
  let connectRetry;
  // Bumped on every start() and stop() so that startups from
  // a previous lifecycle can detect they've been superseded
  let startupGeneration = 0;
  const unsubscribes = {
    signalk: [],
    meshtastic: [],
  };
  const nodes = {};
  // Whether the boat node's firmware can verify packet signatures —
  // Meshtastic 2.8 or newer with verification compiled in. Null until the
  // boat node has reported its DeviceMetadata. Lives at module scope so the
  // configuration schema can gray the setting out when the connected boat
  // node is too old
  let nodeVerification = null;
  const telemetry = new Telemetry();
  let publishInterval;
  let sweepInterval;
  plugin.id = 'signalk-meshtastic';
  plugin.name = 'Meshtastic';
  plugin.description = 'Connect Signal K with the Meshtastic LoRa mesh network';

  // Workaround for loading ESM library
  import('@meshtastic/core')
    .then((lib) => {
      MeshDevice = lib.MeshDevice;
      Protobuf = lib.Protobuf;
      return import('@meshtastic/transport-http');
    })
    .then((lib) => {
      TransportHTTP = lib.TransportHTTP;
      return import('@meshtastic/transport-node');
    })
    .then((lib) => {
      TransportNode = lib.TransportNode;
      return import('@bufbuild/protobuf');
    })
    .then((lib) => {
      create = lib.create;
      toBinary = lib.toBinary;
      if (app.setPluginStatus) {
        app.setPluginStatus('Meshtastic library loaded');
      }
    })
    .catch((e) => {
      app.setPluginError(`Failed to load Meshtastic library: ${e.message}`);
    });

  plugin.start = (startSettings, restart) => {
    // Merge configuration with the schema defaults so that the
    // plugin can also start with an empty configuration
    const settings = {
      ...startSettings,
      device: {
        transport: 'tcp',
        address: 'meshtastic.local',
        log_level: 6,
        heartbeat_interval: 60000,
        ...startSettings && startSettings.device,
      },
    };
    startupGeneration += 1;
    const generation = startupGeneration;
    const isCurrentStartup = () => startupGeneration === generation;
    if (!toBinary) {
      if (app.setPluginStatus) {
        app.setPluginStatus('Waiting for Meshtastic library to load');
      }
      if (!app.getDataDirPath) {
        return;
      }
      startupRetry = setTimeout(() => {
        plugin.start(settings, restart);
      }, 1);
      return;
    }

    const nodeDbFile = join(app.getDataDirPath(), 'node-db.json');

    // Verification verdicts by packet id, for the command dispatch to check.
    // Bounded: the oldest half is dropped whenever it grows past the cap, so
    // a long-running server cannot accumulate entries without bound
    const verificationByPacketId = new Map();
    const VERIFICATION_REGISTRY_MAX = 1024;
    // Node numbers a re-key alert is currently raised for, so the clearing
    // null is only published for nodes that actually had one
    const rekeyAlerts = new Set();

    const rememberVerification = (meshPacket) => {
      verificationByPacketId.set(meshPacket.id, isVerified(meshPacket));
      if (verificationByPacketId.size > VERIFICATION_REGISTRY_MAX) {
        const toDrop = Array.from(verificationByPacketId.keys())
          .slice(0, Math.floor(VERIFICATION_REGISTRY_MAX / 2));
        toDrop.forEach((id) => verificationByPacketId.delete(id));
      }
    };

    telemetry.setAnchorRadiusPath(anchorRadiusPath(settings));

    const metricsInterval = environmentMetricsInterval(settings);
    if (metricsInterval > 0) {
      publishInterval = setInterval(() => {
        if (!device) {
          // Not connected to Meshtastic yet
          return;
        }
        const values = telemetry.toMeshtastic();
        if (Object.keys(values).length === 0) {
          // No telemetry to send
          return;
        }
        const telemetryMessage = create(Protobuf.Telemetry.TelemetrySchema, {
          time: Math.floor(new Date().getTime() / 1000),
          variant: {
            case: 'environmentMetrics',
            value: create(Protobuf.Telemetry.EnvironmentMetricsSchema, values),
          },
        });
        device.sendPacket(
          toBinary(Protobuf.Telemetry.TelemetrySchema, telemetryMessage),
          Protobuf.Portnums.PortNum.TELEMETRY_APP,
          'broadcast',
          broadcastChannel(settings),
          true,
          false,
        )
          .catch((e) => app.error(`Failed to send telemetry: ${e.message}`));
      }, metricsInterval * 1000);
    }

    // Send clearing messages for notifications that have
    // stayed cleared for the hysteresis window
    sweepInterval = setInterval(() => {
      sweepNotifications(episodes, settings, device, app)
        .catch((e) => app.error(`Failed to sweep notifications: ${e.message}`));
    }, 60000);

    function setWatchdog() {
      // Clear previous watchdog
      app.debug(`Watchdog ${watchdogTriggered} reset`);
      if (watchdog) {
        clearTimeout(watchdog);
      }
      const minutes = 10;
      // If we haven't been called in 10min, restart plugin
      watchdog = setTimeout(() => {
        watchdogTriggered += 1;
        app.debug(`Watchdog ${watchdogTriggered} triggered, no packets seen in ${minutes}min`);
        app.error(`Watchdog ${watchdogTriggered} triggered, no packets seen in ${minutes}min`);
        if (restart) {
          restart(settings);
        }
      }, 60000 * minutes);
    }

    function writeNodeDb() {
      writeFile(nodeDbFile, JSON.stringify(nodes, null, 2), 'utf-8')
        .catch((e) => {
          app.error(`Failed to store node DB: ${e.message}`);
        });
    }

    function setConnectionStatus() {
      setWatchdog();
      const now = new Date();
      const nodesOnline = Object.keys(nodes)
        .filter((nodeId) => {
          if (nodes[nodeId].thisNode) {
            // Ignore own node
            return false;
          }
          if (!nodes[nodeId].seen) {
            // Somehow never seen
            return false;
          }
          // Online treshold, should be same as NUM_ONLINE_SECS in Meshtastic fw
          const onlineSecs = 60 * 60 * 2;
          if (nodes[nodeId].seen.getTime() > now.getTime() - (onlineSecs * 1000)) {
            // Seen in last 10min
            return true;
          }
          return false;
        });
      let deviceState = 'unknown status';
      switch (device.deviceStatus) {
        case 1: {
          deviceState = 'restarting';
          break;
        }
        case 2: {
          deviceState = 'disconnected';
          break;
        }
        case 3: {
          deviceState = 'connecting';
          break;
        }
        case 4: {
          deviceState = 'reconnecting';
          break;
        }
        case 5: {
          deviceState = 'connected';
          break;
        }
        case 6: {
          deviceState = 'configuring';
          break;
        }
        case 7: {
          deviceState = 'configured';
          break;
        }
        default: {
          break;
        }
      }
      app.setPluginStatus(`${deviceState.charAt(0).toUpperCase() + deviceState.slice(1)} node at ${settings.device.address} can see ${nodesOnline.length} Meshtastic nodes`);
      let selfId = 'XX';
      Object.keys(nodes).forEach((nodeId) => {
        if (nodes[nodeId].thisNode) {
          selfId = nodeId;
        }
      });

      app.handleMessage('signalk-meshtastic', {
        context: 'vessels.self',
        updates: [
          {
            source: {
              label: 'signalk-meshtastic',
              src: String(selfId),
            },
            timestamp: new Date().toISOString(),
            values: [
              {
                path: 'communication.meshtastic.nodesVisible',
                value: nodesOnline.length,
              },
              {
                path: 'communication.meshtastic.deviceState',
                value: deviceState,
              },
              {
                path: 'communication.meshtastic.deviceStateNum',
                value: device.deviceStatus,
              },
            ],
          },
        ],
      });
    }

    function sendMeta() {
      app.handleMessage('signalk-meshtastic', {
        updates: [
          {
            meta: [
              {
                path: 'communication.meshtastic.airUtilTx',
                value: {
                  units: 'ratio',
                  displayName: 'AirUtilTX',
                  description: 'Utilization for the current channel, including well formed TX, RX and malformed RX (aka noise)',
                },
              },
              {
                path: 'communication.meshtastic.channelUtilization',
                value: {
                  units: 'ratio',
                  displayName: 'ChUtil',
                  description: 'Percent of airtime for transmission used within the last hour',
                },
              },
              {
                path: 'communication.meshtastic.longName',
                value: {
                  displayName: 'Long name',
                  description: 'Full name for the node',
                },
              },
              {
                path: 'communication.meshtastic.shortName',
                value: {
                  displayName: 'Short name',
                  description: 'A VERY short name, ideally two characters',
                },
              },
              {
                path: 'communication.meshtastic.role',
                value: {
                  displayName: 'Role',
                  description: '`User\'s role in the mesh',
                },
              },
              {
                path: 'communication.meshtastic.nodeNum',
                value: {
                  displayName: 'Node number',
                  description: 'A globally unique ID string for this node',
                },
              },
              {
                path: 'communication.meshtastic.nodesVisible',
                value: {
                  displayName: 'Nodes visible',
                  description: 'Number of nodes currently visible to this node',
                },
              },
              {
                path: 'communication.meshtastic.deviceState',
                value: {
                  displayName: 'Device state',
                  description: 'State of connection to the Meshtastic device',
                },
              },
              {
                path: 'communication.meshtastic.deviceStateNum',
                value: {
                  displayName: 'Device state number',
                  description: 'State of connection to the Meshtastic device as numeric value',
                  zones: [
                    {
                      state: 'warn',
                      lower: 0,
                      upper: 5,
                      message: 'Not connected to Meshtastic device',
                    },
                    {
                      state: 'nominal',
                      lower: 7,
                      upper: 8,
                      message: 'Meshtastic connected and configured',
                    },
                  ],
                },
              },
              {
                path: 'communication.meshtastic.uptime',
                value: {
                  displayName: 'Uptime',
                  description: 'How long the device has been running since the last reboot',
                  units: 's',
                },
              },
            ],
          },
        ],
      });
    }

    if (app.setPluginStatus) {
      app.setPluginStatus('Loading Meshtastic node database');
    }
    readFile(nodeDbFile, 'utf-8')
      .catch(() => '{}')
      .then((nodeDb) => {
        let nodeDbData;
        try {
          nodeDbData = JSON.parse(nodeDb);
        } catch (e) {
          app.debug('Error reading Node DB file', e);
          nodeDbData = {};
        }
        Object.keys(nodeDbData)
          .forEach((nodeNum) => {
            nodes[nodeNum] = nodeDbData[nodeNum];
            if (nodeDbData[nodeNum].seen) {
              nodes[nodeNum].seen = new Date(nodeDbData[nodeNum].seen);
            }
          });
        app.setPluginStatus(`Connecting to Meshtastic node ${settings.device.address}`);
        sendMeta();
        if (settings.device && settings.device.transport === 'http') {
          return TransportHTTP.create(settings.device.address);
        }
        return TransportNode.create(settings.device.address);
      })
      .then((transport) => {
        if (!isCurrentStartup()) {
          // Plugin was stopped or restarted while we were connecting
          transport.disconnect()
            .catch((e) => app.debug(`Failed to discard transport: ${e.message}`));
          return undefined;
        }
        device = new MeshDevice(transport);
        unsubscribes.meshtastic.push(
          device.events.onDeviceStatus.subscribe((state) => {
            setConnectionStatus();
            if (state === 2) {
              // Disconnected
              app.debug('Received disconnect event, restarting');
              if (restart) {
                restart(settings);
              }
            }
          }),
          device.events.onMyNodeInfo.subscribe((myNodeInfo) => {
            if (!nodes[myNodeInfo.myNodeNum]) {
              nodes[myNodeInfo.myNodeNum] = {};
            }
            nodes[myNodeInfo.myNodeNum].thisNode = true;
            setConnectionStatus();
          }),
          device.events.onNodeInfoPacket.subscribe((nodeInfo) => {
            if (!nodeInfo.user) {
              return;
            }
            // Meshtastic 2.8 derives the node number from the public key, so
            // flashing a node with 2.8 changes its number. A known public key
            // re-appearing under a new number is the same physical node:
            // migrate the identity and vessel association to the new number,
            // and prune the old one, keeping the old numbers in the entry's id
            // history
            migrateIdentity(nodes, nodeInfo);
            if (!nodes[nodeInfo.num]) {
              nodes[nodeInfo.num] = {};
            }
            nodes[nodeInfo.num].longName = nodeInfo.user.longName;
            nodes[nodeInfo.num].shortName = nodeInfo.user.shortName;
            if (!nodes[nodeInfo.num].publicKey) {
              // Only store the public key once to prevent spoofing
              nodes[nodeInfo.num].publicKey = Buffer.from(nodeInfo.user.publicKey).toString('base64');
            }
            nodes[nodeInfo.num].seen = new Date(nodeInfo.lastHeard * 1000);
            if (nodes[nodeInfo.num].seen > Date.now() - (1000 * 60 * 60 * 24 * 2)) {
              // Node seen less than a two days ago, register with SK
              const ctx = nodeToSignalK(app, nodes[nodeInfo.num], nodeInfo, settings);
              if (ctx && ctx.indexOf('vessels.urn:mrn:imo:mmsi:') === 0) {
                // We have an MMSI match, store it
                nodes[nodeInfo.num].mmsi = ctx.split(':').at(-1);
              }
            }
            // Roles configured for a number in this node's history are stale
            // after a re-key. Roles authorize commands, and the evidence for
            // the re-key is a NodeInfo — unauthenticated on boat nodes before
            // 2.8 — so they are never remapped automatically. Alert while
            // they need reassignment, clear once the configuration no longer
            // references the old numbers. Nodes without a history get no
            // notification traffic at all
            const stale = staleRoles(nodes[nodeInfo.num], settings);
            if (stale.length) {
              rekeyAlerts.add(nodeInfo.num);
            }
            if (stale.length || rekeyAlerts.has(nodeInfo.num)) {
              if (!stale.length) {
                rekeyAlerts.delete(nodeInfo.num);
              }
              app.handleMessage('signalk-meshtastic', {
                context: 'vessels.self',
                updates: [
                  {
                    source: {
                      label: 'signalk-meshtastic',
                      src: String(nodeInfo.num),
                    },
                    timestamp: new Date().toISOString(),
                    values: [{
                      path: `notifications.meshtastic.rekey.${nodeInfo.num}`,
                      value: stale.length ? {
                        state: 'alert',
                        method: ['visual'],
                        message: `Meshtastic node ${nodeInfo.user.longName || nodeInfo.num} re-keyed from ${nodeIdHistory(nodes[nodeInfo.num]).join(', ')} to ${nodeInfo.num}. Reassign its ${stale.map((role) => role.role).join(', ')} role in the plugin configuration`,
                      } : null,
                    }],
                  },
                ],
              });
            }
            if (stale.length) {
              app.debug(`Meshtastic node ${nodeInfo.num} has roles configured for its old numbers: ${stale.map((role) => role.role).join(', ')}`);
            }
            setConnectionStatus();
            writeNodeDb();
          }),
          device.events.onDeviceMetadataPacket.subscribe((metadata) => {
            nodeVerification = nodeCanVerify(metadata);
            if (requireSignedCommands(settings) && nodeVerification === false) {
              app.setPluginStatus(`Meshtastic node at ${settings.device.address} runs firmware older than 2.8: packet signatures cannot be verified, but PKI-encrypted direct messages still are`);
            }
          }),
          device.events.onMeshPacket.subscribe((packet) => {
            rememberVerification(packet);
            if (!nodes[packet.from]) {
              nodes[packet.from] = {};
            }
            if (packet.rxTime) {
              const packetDate = new Date(packet.rxTime * 1000);
              if (packetDate > nodes[packet.from].seen) {
                nodes[packet.from].seen = packetDate;
              }
            }
            setConnectionStatus();
          }),
          device.events.onMessagePacket.subscribe((message) => {
            commands.dispatch(
              message,
              settings,
              device,
              app,
              create,
              Protobuf,
              nodes,
              { verified: verificationByPacketId.get(message.id) },
            );
          }),
          device.events.onTelemetryPacket.subscribe((packet) => {
            if (!nodes[packet.from]) {
              // Unknown node
              return;
            }
            if (packet.data && packet.data.time) {
              const telemetryDate = new Date(packet.data.time * 1000);
              if (telemetryDate > nodes[packet.from].seen) {
                nodes[packet.from].seen = telemetryDate;
              }
            }
            setConnectionStatus();
            const context = getNodeContext(app, nodes[packet.from], packet.from, settings);
            if (!context) {
              // Not a vessel
              return;
            }
            if (packet.data.variant && packet.data.variant.case === 'deviceMetrics') {
              const values = [];
              if (context !== 'vessels.self' || nodes[packet.from].thisNode) {
                values.push(
                  {
                    path: 'communication.meshtastic.uptime',
                    value: packet.data.variant.value.uptimeSeconds,
                  },
                  {
                    path: 'communication.meshtastic.airUtilTx',
                    value: packet.data.variant.value.airUtilTx / 100,
                  },
                  {
                    path: 'communication.meshtastic.channelUtilization',
                    value: packet.data.variant.value.channelUtilization / 100,
                  },
                );
              }
              values.push(
                {
                  path: `electrical.batteries.${packet.from}.capacity.stateOfCharge`,
                  value: packet.data.variant.value.batteryLevel / 100,
                },
                {
                  path: `electrical.batteries.${packet.from}.voltage`,
                  value: packet.data.variant.value.voltage,
                },
              );
              app.handleMessage('signalk-meshtastic', {
                context,
                updates: [
                  {
                    source: {
                      label: 'signalk-meshtastic',
                      src: String(packet.from),
                    },
                    timestamp: new Date().toISOString(),
                    values,
                  },
                ],
              });
              return;
            }
            if (packet.data.variant && packet.data.variant.case === 'environmentMetrics') {
              if (context === 'vessels.self') {
                // We don't need to loop back here
                return;
              }
              const values = [
                {
                  path: 'environment.outside.temperature',
                  value: packet.data.variant.value.temperature + 273.15,
                },
              ];
              if (packet.data.variant.value.windDirection) {
                values.push({
                  path: 'environment.wind.directionTrue',
                  value: packet.data.variant.value.windDirection * (Math.PI / 180),
                });
              }
              if (packet.data.variant.value.windSpeed) {
                values.push({
                  path: 'environment.wind.speedOverGround',
                  value: packet.data.variant.value.windSpeed,
                });
              }
              app.handleMessage('signalk-meshtastic', {
                context,
                updates: [
                  {
                    source: {
                      label: 'signalk-meshtastic',
                      src: String(packet.from),
                    },
                    timestamp: new Date().toISOString(),
                    values,
                  },
                ],
              });
            }
          }),
          device.events.onPositionPacket.subscribe((position) => {
            if (!nodes[position.from]) {
              // Unknown node
              return;
            }
            if (position.data && position.data.time) {
              const positionDate = new Date(position.data.time * 1000);
              if (positionDate > nodes[position.from].seen) {
                nodes[position.from].seen = positionDate;
              }
            }
            setConnectionStatus();
            const context = getNodeContext(app, nodes[position.from], position.from, settings);
            if (!context) {
              // Not a vessel
              return;
            }
            if (context === 'vessels.self') {
              // We don't need to loop back here
              return;
            }
            if (!hasValidPosition(position.data)) {
              // Channels with zero position precision strip the position
              // entirely, leaving protobuf defaults: nothing to publish
              return;
            }
            let groundTrack = 0;
            if (position.data.groundTrack) {
              groundTrack = position.data.groundTrack * 1e-5 * (Math.PI / 180);
            }
            const values = [
              {
                path: 'navigation.position',
                value: {
                  latitude: position.data.latitudeI * 1e-7,
                  longitude: position.data.longitudeI * 1e-7,
                },
              },
              {
                path: 'navigation.speedOverGround',
                value: position.data.groundSpeed || 0,
              },
              {
                path: 'navigation.courseOverGroundTrue',
                value: groundTrack,
              },
              {
                path: 'navigation.gnss.satellites',
                value: position.data.satsInView,
              },
              {
                path: 'navigation.gnss.antennaAltitude',
                value: position.data.altitude || 0,
              },
            ];
            const accuracy = truncationRadius(position.data);
            if (accuracy) {
              // How far off the position can be because the sender truncated
              // it for the channel: undefined when it was sent at full
              // precision
              values.push({
                path: 'communication.meshtastic.positionAccuracy',
                value: Math.round(accuracy),
              });
            }
            app.handleMessage('signalk-meshtastic', {
              context,
              updates: [
                {
                  source: {
                    label: 'signalk-meshtastic',
                    src: String(position.from),
                  },
                  timestamp: new Date().toISOString(),
                  values,
                },
              ],
            });
            if (context && context.indexOf('vessels.urn:mrn:imo:mmsi:') === 0) {
              // We have an MMSI match, store it
              nodes[position.from].mmsi = context.split(':').at(-1);
            }
            writeNodeDb();
          }),
        );

        // Subscribe to Signal K values we may want to transmit to Meshtastic
        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: [
              {
                path: 'navigation.position',
                period: 600000,
              },
              {
                path: 'notifications.*',
                policy: 'instant',
              },
              {
                path: 'environment.outside.temperature',
                period: 1000,
              },
              {
                path: 'environment.outside.relativeHumidity',
                period: 1000,
              },
              {
                path: 'environment.outside.pressure',
                period: 1000,
              },
              {
                path: 'environment.wind.directionTrue',
                period: 1000,
              },
              {
                path: 'environment.wind.speedOverGround',
                period: 1000,
              },
              {
                path: 'electrical.batteries.house.voltage',
                period: 1000,
              },
              {
                path: 'electrical.batteries.house.current',
                period: 1000,
              },
              {
                path: anchorRadiusPath(settings),
                period: 1000,
              },
              {
                path: 'environment.depth.belowSurface',
                period: 1000,
              },
            ],
          },
          unsubscribes.signalk,
          (subscriptionError) => {
            app.error(`Error: ${subscriptionError}`);
          },
          (delta) => {
            if (!delta.updates) {
              return;
            }
            delta.updates.forEach((u) => {
              if (!u.values) {
                return;
              }
              u.values.forEach((v) => {
                if (v.path === 'navigation.position') {
                  if (!device) {
                    // Not connected to Meshtastic yet
                    return;
                  }
                  if (!Number.isFinite(v.value.latitude)
                    || !Number.isFinite(v.value.longitude)) {
                    // No position
                    return;
                  }
                  if (!settings.communications || !settings.communications.send_position) {
                    return;
                  }
                  device.setFixedPosition(v.value.latitude, v.value.longitude)
                    .catch((e) => app.error(`Failed to set node position: ${e.message}`));
                  return;
                }
                if (v.path.indexOf('notifications.') === 0) {
                  sendNotification(v.path, v.value, episodes, settings, device, app);
                  if (v.path.indexOf('notifications.mob.') === 0) {
                    // This is a notification about a MOB beacon, create waypoint
                    sendMOB(
                      v.path,
                      v.value,
                      app,
                      device,
                      create,
                      Protobuf,
                      broadcastChannel(settings),
                    );
                  }
                  return;
                }
                if (v.path === 'environment.wind.speedOverGround') {
                  telemetry.updateWindSpeed(v.value);
                  return;
                }
                // The others go to the telemetry object
                telemetry.update(v.path, v.value);
              });
            });
          },
        );

        device.log.settings.minLevel = settings.device.log_level;
        return device.configure();
      })
      .then(() => {
        if (!isCurrentStartup() || !device) {
          return;
        }
        app.debug(`Connected and configured with Meshtastic node ${settings.device.address}`);
        app.setPluginStatus(`Connected to Meshtastic node ${settings.device.address}`);
        device.setHeartbeatInterval(settings.device.heartbeat_interval || 60000);
      })
      .catch((e) => {
        if (!isCurrentStartup()) {
          // Plugin was stopped while we were connecting, no need to retry
          return;
        }
        // Couldn't find node, possibly due to a node restart/crash
        // Try connecting again after a while
        app.error(`Unable to connect to node ${settings.device.address}: ${e.code} ${e.message}. Retrying`);
        connectRetry = setTimeout(() => {
          app.debug('Triggered restart due to failed initial connect/configure');
          if (restart) {
            restart(settings);
          }
        }, 30000);
      });
  };
  plugin.stop = () => {
    // Invalidate startups that are still connecting
    startupGeneration += 1;
    // The boat node is gone until the plugin connects again; forget what
    // its firmware could and could not verify
    nodeVerification = null;
    if (publishInterval) {
      clearInterval(publishInterval);
      publishInterval = undefined;
    }
    if (sweepInterval) {
      clearInterval(sweepInterval);
    }
    if (watchdog) {
      clearTimeout(watchdog);
    }
    if (startupRetry) {
      clearTimeout(startupRetry);
      startupRetry = undefined;
    }
    if (connectRetry) {
      clearTimeout(connectRetry);
      connectRetry = undefined;
    }
    unsubscribes.signalk.forEach((f) => f());
    unsubscribes.signalk = [];
    unsubscribes.meshtastic.forEach((f) => f());
    unsubscribes.meshtastic = [];
    episodes.clear();

    if (!device || device.deviceStatus === 2) {
      return;
    }
    device.disconnect()
      .catch((e) => {
        app.error(`Failed to disconnect: ${e.message}`);
      });
  };
  plugin.schema = () => {
    function nodeList() {
      if (Object.keys(nodes).length === 0) {
        return [];
      }
      return Object.keys(nodes)
        .filter((nodeId) => {
          if (nodes[nodeId].thisNode) {
            return false;
          }
          return true;
        })
        .map((nodeId) => {
          const node = nodes[nodeId];
          return {
            const: parseInt(nodeId, 10),
            title: `${nodeId} ${node.shortName} (${node.longName})`,
          };
        });
    }
    const schema = {
      type: 'object',
      properties: {
        device: {
          type: 'object',
          title: 'Meshtastic device connection settings',
          properties: {
            transport: {
              type: 'string',
              default: 'tcp',
              title: 'How to connect to the boat Meshtastic node',
              oneOf: [
                {
                  const: 'tcp',
                  title: 'TCP (nodes connected to same network, typically ESP32)',
                },
                {
                  const: 'http',
                  title: 'HTTP (nodes connected to same network, typically ESP32)',
                },
              ],
            },
            address: {
              type: 'string',
              default: 'meshtastic.local',
              title: 'Address of the Meshtastic node',
            },
            log_level: {
              type: 'integer',
              default: 6,
              title: 'Meshtastic log level',
            },
            heartbeat_interval: {
              type: 'integer',
              default: 60000,
              title: 'Heartbeat inverval (milliseconds)',
            },
          },
        },
        nodes: {
          type: 'array',
          title: 'Related Meshtastic nodes',
          minItems: 0,
          items: {
            type: 'object',
            required: [
              'node',
              'role',
            ],
            properties: {
              node: {
                type: 'integer',
                title: 'Node',
                oneOf: nodeList(),
              },
              role: {
                type: 'string',
                title: 'Role',
                oneOf: [
                  {
                    const: 'crew',
                    title: 'Node carried by crew member',
                  },
                  {
                    const: 'dinghy',
                    title: 'Dinghy tracker node',
                  },
                  {
                    const: 'onboard',
                    title: 'Onboard equipment',
                  },
                ],
              },
              name: {
                type: 'string',
                title: 'Name',
                description: 'Name of the crew member carrying this node, used as the author of logbook entries sent from it',
              },
            },
          },
        },
        communications: {
          type: 'object',
          title: 'Communications with Meshtastic',
          properties: {
            send_position: {
              type: 'boolean',
              title: 'Update Meshtastic node position from Signal K vessel position',
              default: true,
            },
            send_alerts: {
              type: 'boolean',
              title: 'Send alerts to crew via Meshtastic',
              default: true,
            },
            environment_metrics_interval: {
              type: 'integer',
              title: 'How often to send environment metrics (wind, temperature, etc) to Meshtastic, in seconds. Set to 0 to disable',
              default: 0,
              minimum: 0,
            },
            broadcast_channel: {
              type: 'integer',
              title: 'Meshtastic channel to broadcast on',
              description: 'Environment metrics and MOB waypoints are broadcast on this channel index. Channel 0 is the primary channel every node shares; use the index of a secondary channel to keep the broadcasts off the public mesh. Direct messages to crew and replies to commands are encrypted for the recipient, and replies travel on the channel the command arrived from',
              default: 0,
              minimum: 0,
              maximum: 7,
            },
            require_signed_commands: {
              type: 'boolean',
              title: 'Require commands to be cryptographically signed',
              description: nodeVerification === false
                ? 'Not available: the connected Meshtastic node runs firmware older than 2.8 and cannot verify packet signatures. Update its firmware to enable this setting'
                : 'Commands that control the boat (digital switching etc) are only executed when their packet was verified cryptographically: signed with the sending node\'s key, or PKI-encrypted so only the node holding that key could have sent it. Unverified packets may carry a forged sender number. Sending nodes need Meshtastic 2.8 or newer with packet signing, and the boat node needs 2.8 or newer for signature verification',
              default: false,
              ...(nodeVerification === false ? { disabled: true } : {}),
            },
            anchor_radius_path: {
              type: 'string',
              default: 'navigation.anchor.distanceFromBow',
              title: 'Signal K path to use for the anchor radius reported in environment metrics',
              oneOf: [
                {
                  const: 'navigation.anchor.distanceFromBow',
                  title: 'navigation.anchor.distanceFromBow (anchor rode deployed)',
                },
                {
                  const: 'navigation.anchor.currentRadius',
                  title: 'navigation.anchor.currentRadius (current distance from anchor)',
                },
              ],
            },
            status_paths: {
              type: 'array',
              title: 'Additional Signal K paths to include in the "Status" reply',
              description: 'Each path is reported as "Label: value", for example "WAN: Cellular" for networking.wan.activeLabel labelled "WAN". Paths the server describes as a ratio are reported as a percentage. Remove the entries to leave them out of the reply',
              default: DEFAULT_STATUS_PATHS,
              items: {
                type: 'object',
                required: ['path', 'label'],
                properties: {
                  path: {
                    type: 'string',
                    title: 'Signal K path',
                    description: 'For example networking.wan.activeLabel',
                  },
                  label: {
                    type: 'string',
                    title: 'Label',
                    description: 'Short label shown before the value, for example WAN',
                  },
                },
              },
            },
            digital_switching: {
              type: 'boolean',
              title: 'Allow crew members to change digital switch status by Meshtastic message ("turn decklight on")',
              default: false,
            },
            populate_vessels: {
              type: 'boolean',
              title: 'Populate Signal K vessels for Meshtastic devices sharing location (for display in Freeboard etc)',
              default: false,
            },
          },
        },
      },
    };
    return schema;
  };

  return plugin;
};
