/* eslint import/no-unresolved: 1 */
const { readFile, writeFile } = require('fs/promises');
const { join } = require('path');

// Hack for Node.js compatibility of Meshtastic Deno lib
const crypto = require('node:crypto');

const Telemetry = require('./telemetry');

global.crypto = crypto;

// The ES modules we'll need to import
let MeshDevice;
let TransportHTTP;
let create;
let toBinary;
let Protobuf;

function getNodeContext(app, node, nodeNum, settings) {
  if (node.thisNode) {
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
  if (!context) {
    return;
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
        },
        timestamp: new Date().toISOString(),
        values,
      },
    ],
  });
}

module.exports = (app) => {
  const plugin = {};
  let device;
  let watchdog;
  let watchdogTriggered = 0;
  const unsubscribes = {
    signalk: [],
    meshtastic: [],
  };
  const nodes = {};
  const telemetry = new Telemetry();
  let publishInterval;
  plugin.id = 'signalk-meshtastic';
  plugin.name = 'Meshtastic';
  plugin.description = 'Connect Signal K with the Meshtastic LoRa mesh network';

  // Workaround for loading ESM library
  import('@meshtastic/core')
    .then((lib) => {
      MeshDevice = lib.MeshDevice;
      return import('@meshtastic/transport-http');
    })
    .then((lib) => {
      TransportHTTP = lib.TransportHTTP;
      return import('@bufbuild/protobuf');
    })
    .then((lib) => {
      create = lib.create;
      toBinary = lib.toBinary;
      return import('@meshtastic/protobufs');
    })
    .then((lib) => {
      Protobuf = lib;
      app.setPluginStatus('Meshtastic library loaded');
    })
    .catch((e) => {
      app.setPluginError(`Failed to load Meshtastic library: ${e.message}`);
    });

  plugin.start = (settings, restart) => {
    if (!TransportHTTP) {
      app.setPluginStatus('Waiting for Meshtastic library to load');
      setTimeout(() => {
        plugin.start(settings, restart);
      }, 1);
      return;
    }

    const nodeDbFile = join(app.getDataDirPath(), 'node-db.json');

    publishInterval = setInterval(() => {
      if (!device) {
        // Not connected to Meshtastic yet
        return;
      }
      if (!settings.communications || !settings.communications.send_environment_metrics) {
        // Metrics sending disabled
        return;
      }
      const values = telemetry.toMeshtastic();
      if (Object.keys(values).length === 0) {
        // No telemetry to send
        return;
      }
      const telemetryMessage = create(Protobuf.Telemetry.TelemetrySchema, {
        variant: {
          case: 'environmentMetrics',
          value: create(Protobuf.Telemetry.EnvironmentMetricsSchema, values),
        },
      });
      device.sendPacket(
        toBinary(Protobuf.Telemetry.TelemetrySchema, telemetryMessage),
        Protobuf.Portnums.PortNum.TELEMETRY_APP,
        'broadcast',
        0,
        true,
        false,
      )
        .catch((e) => app.error(`Failed to send telemetry: ${e.message}`));
    }, 60000 * 4);

    function setWatchdog() {
      // Clear previous watchdog
      console.log(`Watchdog ${watchdogTriggered} reset`);
      if (watchdog) {
        clearTimeout(watchdog);
      }
      const minutes = 10;
      // If we haven't been called in 10min, restart plugin
      watchdog = setTimeout(() => {
        watchdogTriggered += 1;
        console.log(`Watchdog ${watchdogTriggered} triggered, no packets seen in ${minutes}min`);
        app.error(`Watchdog ${watchdogTriggered} triggered, no packets seen in ${minutes}min`);
        restart(settings);
      }, 60000 * minutes);
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
          if (nodes[nodeId].seen.getTime() > now.getTime() - 600000) {
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
      app.handleMessage('signalk-meshtastic', {
        context: 'vessels.self',
        updates: [
          {
            source: {
              label: 'signalk-meshtastic',
            },
            timestamp: new Date().toISOString(),
            values: [
              {
                path: 'communication.meshtastic.nodesVisible',
                value: nodesOnline.length,
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

    app.setPluginStatus('Loading Meshtastic node database');
    readFile(nodeDbFile, 'utf-8')
      .catch(() => '{}')
      .then((nodeDb) => {
        const nodeDbData = JSON.parse(nodeDb);
        Object.keys(nodeDbData)
          .forEach((nodeNum) => {
            nodes[nodeNum] = nodeDbData[nodeNum];
            nodes[nodeNum].seen = new Date(nodeDbData[nodeNum].seen);
          });
        app.setPluginStatus(`Connecting to Meshtastic node ${settings.device.address}`);
        sendMeta();
        return TransportHTTP.create(settings.device.address);
      })
      .then((transport) => {
        device = new MeshDevice(transport);

        unsubscribes.meshtastic.push(
          device.events.onDeviceStatus.subscribe(() => {
            setConnectionStatus();
          }),
          device.events.onMyNodeInfo.subscribe((myNodeInfo) => {
            if (!nodes[myNodeInfo.myNodeNum]) {
              nodes[myNodeInfo.myNodeNum] = {};
            }
            nodes[myNodeInfo.myNodeNum].thisNode = true;
            setConnectionStatus();
          }),
          device.events.onNodeInfoPacket.subscribe((nodeInfo) => {
            if (!nodes[nodeInfo.num]) {
              nodes[nodeInfo.num] = {};
            }
            nodes[nodeInfo.num].longName = nodeInfo.user.longName;
            nodes[nodeInfo.num].shortName = nodeInfo.user.shortName;
            nodes[nodeInfo.num].seen = new Date();
            nodeToSignalK(app, nodes[nodeInfo.num], nodeInfo, settings);
            setConnectionStatus();
            writeFile(nodeDbFile, JSON.stringify(nodes, null, 2), 'utf-8')
              .catch((e) => {
                app.error(`Failed to store node DB: ${e.message}`);
              });
          }),
          device.events.onMeshPacket.subscribe((packet) => {
            if (!nodes[packet.from]) {
              nodes[packet.from] = {};
            }
            nodes[packet.from].seen = new Date();
            setConnectionStatus();
          }),
          device.events.onMessagePacket.subscribe((message) => {
            if (message.type !== 'direct') {
              // Not DM
              return;
            }
            const crew = settings.nodes
              .filter((node) => {
                if (node.role === 'crew') {
                  return true;
                }
                return false;
              })
              .map((node) => node.node);
            if (crew.indexOf(message.from) === -1) {
              // Not from crew
              return;
            }
            const switching = message.data.match(/turn ([a-z0-9]+) (on|off)/i);
            if (settings.communications
              && settings.communications.digital_switching
              && switching) {
              const light = switching[1];
              const value = switching[2] === 'on';
              app.putSelfPath(`electrical.switches.${light}.state`, value, (res) => {
                if (res.state !== 'COMPLETED') {
                  return;
                }
                if (res.statusCode !== 200) {
                  device.sendText(res.message, message.from, true, false)
                    .catch((e) => app.error(`Failed to send message: ${e.message}`));
                  return;
                }
                device.sendText(`OK, ${light} is ${switching[2]}`, message.from, true, false)
                  .catch((e) => app.error(`Failed to send message: ${e.message}`));
              });
            }
          }),
          device.events.onTelemetryPacket.subscribe((packet) => {
            if (!nodes[packet.from]) {
              // Unknown node
              return;
            }
            const context = getNodeContext(app, nodes[packet.from], packet.from, settings);
            if (!context) {
              // Not a vessel
              return;
            }
            if (packet.data.variant && packet.data.variant.case === 'deviceMetrics') {
              const values = [
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
                {
                  path: `electrical.batteries.${packet.from}.capacity.stateOfCharge`,
                  value: packet.data.variant.value.batteryLevel / 100,
                },
                {
                  path: `electrical.batteries.${packet.from}.voltage`,
                  value: packet.data.variant.value.voltage,
                },
              ];
              app.handleMessage('signalk-meshtastic', {
                context,
                updates: [
                  {
                    source: {
                      label: 'signalk-meshtastic',
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
            const context = getNodeContext(app, nodes[position.from], position.from, settings);
            if (!context) {
              // Not a vessel
              return;
            }
            if (context === 'vessels.self') {
              // We don't need to loop back here
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
                value: position.data.altitude,
              },
            ];
            app.handleMessage('signalk-meshtastic', {
              context,
              updates: [
                {
                  source: {
                    label: 'signalk-meshtastic',
                  },
                  timestamp: new Date().toISOString(),
                  values,
                },
              ],
            });
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
                path: 'navigation.anchor.distanceFromBow',
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
                  if (!settings.communications || !settings.communications.send_position) {
                    return;
                  }
                  const setPositionMessage = create(Protobuf.Admin.AdminMessageSchema, {
                    payloadVariant: {
                      case: 'setFixedPosition',
                      value: create(Protobuf.Mesh.PositionSchema, {
                        latitudeI: Math.floor(v.value.latitude / 1e-7),
                        longitudeI: Math.floor(v.value.longitude / 1e-7),
                      }),
                    },
                  });
                  device.sendPacket(
                    toBinary(Protobuf.Admin.AdminMessageSchema, setPositionMessage),
                    Protobuf.Portnums.PortNum.ADMIN_APP,
                    'self',
                    0,
                    true,
                    false,
                  )
                    .catch((e) => app.error(`Failed to set node position: ${e.message}`));
                  return;
                }
                if (v.path.indexOf('notifications.') === 0) {
                  if (!device) {
                    // Not connected to Meshtastic yet
                    return;
                  }
                  if (!settings.communications || !settings.communications.send_alerts) {
                    return;
                  }
                  if (!v.value) {
                    return;
                  }
                  if (!v.value.state || ['alarm', 'emergency'].indexOf(v.value.state) === -1) {
                    return;
                  }
                  const crew = settings.nodes.filter((node) => node.role === 'crew');
                  if (!crew.length) {
                    return;
                  }
                  crew.reduce(
                    (prev, member) => prev.then(() => device.sendText(`\u0007 ${v.value.message}`, member.node, true, false)),
                    Promise.resolve(),
                  )
                    .catch((e) => app.error(`Failed to send alert: ${e.message}`));
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
      .catch((e) => {
        // Configure often times out, we can ignore it
        app.error(`Failed to connect: ${e.message}`);
      })
      .then(() => {
        app.setPluginStatus(`Connected to Meshtastic node ${settings.device.address}`);
      });
  };
  plugin.stop = () => {
    if (publishInterval) {
      clearInterval(publishInterval);
    }
    if (watchdog) {
      clearTimeout(watchdog);
    }
    unsubscribes.signalk.forEach((f) => f());
    unsubscribes.signalk = [];
    unsubscribes.meshtastic.forEach((f) => f());
    unsubscribes.meshtastic = [];

    if (!this.device) {
      return;
    }
    this.device.disconnect()
      .catch((e) => {
        app.error(`Failed to disconnect: ${e.message}`);
      });
  };
  plugin.schema = () => {
    function nodeList() {
      if (Object.keys(nodes).length === 0) {
        return undefined;
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
              default: 'http',
              title: 'How to connect to the boat Meshtastic node',
              oneOf: [
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
            send_environment_metrics: {
              type: 'boolean',
              title: 'Send environment metrics (wind, temperature, etc) to Meshtastic',
              default: false,
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
