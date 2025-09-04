const { vesselIcon } = require('../waypoint');

const regex = /waypoint ([a-z0-9]+)( ([0-9]+)h)?/i;

module.exports = {
  crewOnly: true,
  accept: (msg) => {
    // FIXME: Add support for vessel names with spaces
    const waypointTgt = msg.data.match(regex);
    if (waypointTgt) {
      return true;
    }
    return false;
  },
  handle: (msg, device, app, create, Protobuf) => {
    const waypointTgt = msg.data.match(regex);
    const identifier = waypointTgt[1];
    const length = waypointTgt[3] || 1;
    const waypointVesselCtx = Object.keys(app.signalk.root.vessels)
      .find((vesselCtx) => {
        const vessel = app.signalk.root.vessels[vesselCtx];
        const lIdentifier = identifier.toLowerCase();
        if (vessel.mmsi === identifier) {
          return true;
        }
        if (vessel.name && vessel.name.toLowerCase() === lIdentifier) {
          return true;
        }
        if (vessel.communication
          && vessel.communication.callsignVhf
          && vessel.communication.callsignVhf.toLowerCase() === lIdentifier) {
          return true;
        }
        return false;
      });
    if (!waypointVesselCtx) {
      return device.sendText(`Unable to find vessel ${identifier}`, msg.from, true, false);
    }
    const waypointVessel = app.signalk.root.vessels[waypointVesselCtx];
    if (!waypointVessel.navigation.position.value
      || !waypointVessel.navigation.position.value.latitude) {
      return device.sendText(`Vessel ${identifier} has no known position`, msg.from, true, false);
    }
    const setWaypointMessage = create(Protobuf.Mesh.WaypointSchema, {
      id: waypointVessel.mmsi,
      latitudeI: Math.floor(waypointVessel.navigation.position.value.latitude / 1e-7),
      longitudeI: Math.floor(waypointVessel.navigation.position.value.longitude / 1e-7),
      expire: Math.floor((new Date().getTime() / 1000) + (length * 60 * 60)),
      name: waypointVessel.name,
      description: `AIS vessel ${waypointVessel.mmsi}`,
      icon: vesselIcon(waypointVessel),
    });
    return device.sendWaypoint(setWaypointMessage, 'broadcast', 0);
  },
};
