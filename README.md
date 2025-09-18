Signal K integration with Meshtastic
====================================

This plugin enables vessels running [Signal K](https://signalk.org) to interact with the [Meshtastic](https://meshtastic.org) mesh network. Meshtastic allows radio communications between relatively inexpensive LoRa devices over long distances. The Signal K Meshtastic plugin allows seeing telemetry and receiving alerts from your vessel while ashore. It can also control vessel features like digital switching over text message.

If desired, telemetry and position information can also be shared between multiple Meshtastic-using vessels, making it effectively a "pseudo-AIS" system.

![Basic Meshtastic communications](https://github.com/meri-imperiumi/signalk-meshtastic/raw/main/doc/meshtastic-bequia.png)

Being a mesh network, there is no need for external telecommunications infrastructure or monthly payments. This means communication between Meshtastic devices onboard and on shore can work just as well in the Finnish Archipelago Sea as in the Tuamotus. In more densely populated places communications may benefit from other Meshtastic users relaying the messages, making it possible to communicate with the boat across a city.

This plugin is designed to work with regular unmodified Meshtastic devices and settings. You can keep your boat and other Meshtastic nodes either in the public channel, or [set up your private mesh](https://meshtastic.org/docs/configuration/tips/#not-sharing-your-location). With a private channel the location of your devices won't be visible to the public, and communications between them will be encrypted.

Many different kinds of Meshtastic devices are available, from basic microcontroller boards to ready-to-go consumer devices. Some are entirely standalone with screens and keyboards, and others need a smartphone app.

[Here is a good introduction](https://tech.gillyb.net/understanding-meshtastic-off-grid-communication-made-simple/) to Meshtastic:
> Picture this: you’re a family is anchored in a bay. Parents are hiking inland, kids are visiting friends on another boat, and you’re on your boat (“Boat Node”) in the middle. When the kids send, “What’s for dinner?”, Meshtastic uses “flood routing” to make sure it reaches everyone.
> Here’s how it works:
> - The kids’ node sends the message.
> - Boat Node receives it and decides, “This is new—let’s pass it on!”
> - Boat Node rebroadcasts the message.
> - Parents’ node, unable to hear the kids directly, receives it through Boat Node.

There's also an [introduction to signalk-meshtastic](https://signalk.org/2025/signalk-meshtastic/) on the Signal K website.

## Status

In production use on several boats.

## Features

* Connect to a Meshtastic node via HTTP, TCP, or Serial
  * Keep a persistent database of all seen Meshtastic nodes
* Update Meshtastic node position from Signal K GNSS position
* Send Signal K alerts as Meshtastic text messages to crew
  * MOB alerts (for example from [signalk-mob-notifier](https://github.com/meri-imperiumi/signalk-mob-notifier)) also send a waypoint to the MOB beacon
* Control Signal K with Meshtastic direct messages:
  * Share Meshtastic waypoints for AIS targets (_"Waypoint DH8613"_)
  * Control digital switching (_"Turn decklight on"_). Opt-in.
* Share weather station data from Signal K (wind, temperature, etc) over Meshtastic. Opt-in.
* Show position-sharing Meshtastic nodes as vessels in Freeboard etc. Opt-in.
  * Associate Meshtastic nodes with other (AIS) vessels based on the `Some node name DE <callsign>` pattern

## Planned features

* Guard mode to alert if the tracked dinghy moves
* Keeping a mileage log for the dinghy
* More text commands over Meshtastic to query vessel status etc

## Requirements

* This plugin running inside your Signal K installation
* One [Meshtastic device](https://meshtastic.org/docs/hardware/devices/) running and connected to the same network (typically boat WiFi) as Signal K. This should be an [ESP32 based](https://meshtastic.org/docs/hardware/devices/heltec-automation/lora32/?heltec=v3) device for WiFi connectivity.<br>
  If using Serial connection, it can also be a nRF52 device
* At least one additional Meshtastic device for the crew ashore. [Seeed T1000-e](https://meshtastic.org/docs/hardware/devices/seeed-studio/sensecap/card-tracker/) is a great option, but any battery-powered Meshtastic device will work. Having a device for each crew member is even better. In busy areas these should be set to [`CLIENT_MUTE` role](https://meshtastic.org/blog/choosing-the-right-device-role/)
* Optionally, a Meshtastic GPS tracker device installed in the dinghy
* Optionally, a [Meshtastic mast-top repeater](https://www.printables.com/model/1396221-meshtastic-boat-module-masthead) for greatly increased communications range

LoRa is line-of-sight communications quite similarly to VHF. Communications range would greatly benefit from a Meshtastic repeater installed high in the mast. Similarly, repeaters on nearby hills or high buildings can be helpful. But just with the boat node and the node carried by crew it should be possible to reach ranges of over 1km. We've been able to communicate at over 8km distances in our early tests in Curacao.

**Please note** that this plugin connects to the "boat node" as a client, meaning that while Signal K is running, the regular Meshtastic client app _won't be able to connect to the same device_. It is a good idea to [enable remote administration](https://meshtastic.org/docs/configuration/radio/security/#admin-key) so that you can modify the settings of the device over LoRa.

## Getting started

* Configure your "boat Meshtastic node" device so that it is connected to your boat network
* If you have a valid Ship Station License, add your callsign to the long name of the node. Typical pattern is `<Vessel name> DE <Callsign>`, for example _"Lille Oe DE DH8613"_<br>
  (yes, you need to use `DE` also for non-German vessels. This is radio slang for "this is", not a country code)
* Install and enable this plugin, and set up the connection details (IP address etc)
* Wait for some minutes for the plugin to see nearby Meshtastic nodes
* Configure plugin and set appropriate roles for the crew and dinghy tracker Meshtastic devices

![](https://github.com/meri-imperiumi/signalk-meshtastic/raw/main/doc/config-crew-role.png)

## Telemetry sent to Meshtastic

If enabled, your "boat node" will transmit the following telemetry to Meshtastic. This enables tracking various important metrics about your boat also remotely. They are visible in the device details in your Meshtastic app:

![](https://github.com/meri-imperiumi/signalk-meshtastic/raw/main/doc/telemetry.png)

Metrics used:

* Temperature (from `environment.outside.temperature`)
* Relative humidity (from `environment.outside.relativeHumidity`)
* Barometric pressure (from `environment.outside.pressure`)
* Wind direction (from `environment.wind.directionTrue`)
* Wind speed (median of last ten minutes from `environment.wind.speedOverGround`)
* Battery voltage (from `electrical.batteries.house.voltage`)
* Battery current (from `electrical.batteries.house.current`)
* If anchored, distance to anchor (from `navigation.anchor.distanceFromBow`)
* If not anchored, distance is water depth (from `environment.depth.belowSurface`)

## Changes

* 1.1.1 (2025-09-18)
  - Fixed empty response text message to digital switching actions
  - Added support for the proposed Signal K MOB position specification
* 1.1.0 (2025-09-11)
  - Added support for Serial transport with the Meshtastic device
* 1.0.0 (2025-09-11)
  - Initial release with HTTP and TCP transports
