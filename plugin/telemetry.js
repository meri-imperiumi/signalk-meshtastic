function median(arr) {
  if (!arr.length) {
    return undefined;
  }
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] + s[mid]) / 2);
}

class Telemetry {
  constructor() {
    this.data = {};
  }

  toMeshtastic() {
    const values = {};
    if (this.data['environment.outside.temperature']) {
      values.temperature = this.data['environment.outside.temperature'] - 273.15;
    }
    if (this.data['environment.outside.relativeHumidity']) {
      values.relativeHumidity = this.data['environment.outside.relativeHumidity'] * 100;
    }
    if (this.data['environment.outside.pressure']) {
      values.barometricPressure = this.data['environment.outside.pressure'] / 100;
    }
    if (this.data['environment.wind.directionTrue']) {
      values.windDirection = Math.floor(this.data['environment.wind.directionTrue'] * (180 / Math.PI));
    }
    if (this.data['environment.wind.speedOverGround'] && this.data['environment.wind.speedOverGround'].length) {
      values.windSpeed = median(this.data['environment.wind.speedOverGround']);
      values.windGust = this.data['environment.wind.speedOverGround'].reduce((prev, current) => (current > prev ? current : prev), 0);
      values.windLull = this.data['environment.wind.speedOverGround'].reduce((prev, current) => {
        if (!prev) {
          return current;
        }
        return current < prev ? current : prev;
      }, 0);
      // Clear wind history
      this.data['environment.wind.speedOverGround'] = [];
    }
    if (this.data['electrical.batteries.house.voltage']) {
      values.voltage = this.data['electrical.batteries.house.voltage'];
    }
    if (this.data['electrical.batteries.house.current']) {
      values.current = this.data['electrical.batteries.house.current'] * 1000;
    }
    if (this.data['navigation.anchor.distanceFromBow']) {
      // Using distance is a bit silly here as the unit is mm, but what can we do
      values.distance = this.data['navigation.anchor.distanceFromBow'] * 1000;
    } else if (this.data['environment.depth.belowSurface']) {
      // If not anchored, report depth as distance. Still mm.
      values.distance = this.data['environment.depth.belowSurface'] * 1000;
    }
    return values;
  }

  updateWindSpeed(windSpeed) {
    if (!this.data['environment.wind.speedOverGround']) {
      this.data['environment.wind.speedOverGround'] = [];
    }
    this.data['environment.wind.speedOverGround'].push(windSpeed);
  }

  update(path, value) {
    this.data[path] = value;
  }
}

module.exports = Telemetry;
