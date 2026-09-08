const { vesselIcon, sendWaypoint } = require('../waypoint');

const regex = /waypoint (?<name>.+?)(?: (?<hours>[0-9]+)h)?\s*$/i;

module.exports = {
  crewOnly: true,
  example: 'Waypoint <callsign or boat name>',
  accept: (msg) => {
    const waypointTgt = msg.data.match(regex);
    if (waypointTgt) {
      return true;
    }
    return false;
  },
  handle: (msg, settings, device, app, create, Protobuf) => {
    const waypointTgt = msg.data.match(regex);
    const identifier = waypointTgt.groups.name.trim().normalize('NFC');
    const lIdentifier = identifier.toLowerCase();
    const length = Number(waypointTgt.groups.hours || 1);

    const waypointVesselCtx = Object.keys(app.signalk.root.vessels)
      .find((vesselCtx) => {
        const vessel = app.signalk.root.vessels[vesselCtx];

        if (vessel.mmsi === identifier) {
          return true;
        }

        if (
          vessel.name
          && vessel.name.trim().normalize('NFC').toLowerCase() === lIdentifier
        ) {
          return true;
        }

        if (
          vessel.communication
          && vessel.communication.callsignVhf
          && vessel.communication.callsignVhf.toLowerCase() === lIdentifier
        ) {
          return true;
        }

        return false;
      });

    if (!waypointVesselCtx) {
      return device.sendText(`Unable to find vessel ${identifier}`, msg.from, true, false);
    }

    const waypointVessel = app.signalk.root.vessels[waypointVesselCtx];
    const position = waypointVessel.navigation?.position?.value;

    if (
      position?.latitude == null
      || position?.longitude == null
    ) {
      return device.sendText(
        `Vessel ${identifier} has no known position`,
        msg.from,
        true,
        false,
      );
    }

    return sendWaypoint(
      waypointVessel.mmsi,
      position,
      waypointVessel.name || waypointVessel.mmsi,
      `AIS vessel ${waypointVessel.mmsi}`,
      vesselIcon(waypointVessel),
      length,
      msg.from,
      device,
      create,
      Protobuf,
    );
  },
};
