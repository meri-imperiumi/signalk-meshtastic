# Changelog
## [1.5.0] - 2026-07-18
### Fixed
- Send notifications registry should now expire after some time

### Changed
- All delta source IDs are now cast as strings.

### Removed
- Removed the setting to disable populating delta sources

## [1.4.1] - 2026-07-10
### Fixed
- Added setting to disable populating delta source IDs as that [crashes OpenCPN](https://github.com/OpenCPN/OpenCPN/issues/5224#issuecomment-4929856487)

## [1.4.0] - 2026-06-19
### Added
- Notifications that clear and reissue rapidly are only sent once

### Changed
- Refactored notification and waypoint sending to their own helper functions

## [1.3.0] - 2026-06-16
### Removed
- Removed support for serial connections as they require post-install scripts

## [1.2.4] - 2026-02-15
### Fixed
- Corrupted Node DB file should no longer crash the plugin

## [1.2.3] - 2025-10-15
### Changed
- Nodes that haven't been seen in last two days are no longer registered to Signal K data structure

### Fixed
- Added safeties for various non-numeric telemetry and coordinate values

## [1.2.2] - 2025-10-01
### Changed
- Set "last seen" timestamp of nodes based on packet payloads, not the time they're received
- Send timestamp with telemetry

### Fixed
- Fixed issue with persising node-to-vessel matches from `DE <callsign>`

## [1.2.1] - 2025-09-28
### Fixed
- Fixed issue with Signal K servers that don't have navigation.position set

## [1.2.0] - 2025-09-28
### Added
- Support for Node.js older than 22.x, for example as seen in Venus OS Large

### Changed
- Safety for nodes in DB that don't have a "last seen" timestamp
- Made connection status notifications clearer

## [1.1.2] - 2025-09-25
### Added
- Added support for the new roles from Meshtastic 2.7 (`ROUTER_LATE` and `CLIENT_BASE`)

### Fixed
- Fixed issue with sending a bell with alerts that have sound enabled

## [1.1.1] - 2025-09-18
### Added
- Added support for the proposed Signal K MOB position specification

### Fixed
- Fixed empty response text message to digital switching actions

## [1.1.0] - 2025-09-11
### Added
- Added support for Serial transport with the Meshtastic device

## [1.0.0] - 2025-09-11
### Changed
- Initial release with HTTP and TCP transports
