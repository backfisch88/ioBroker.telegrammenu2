# Changelog

## 0.2.0

- Added percent-step/number-range value pickers (inline keyboard with the current value marked, plus a numeric-keypad "custom value" option supporting decimals)
- Added event listeners: automatically push a menu to authorized users when a datapoint condition matches
- Added HTTP-request buttons (with optional Basic Auth)
- Added multi-status buttons (more than two states, each with its own emoji/label/target)
- Added an adjustable "buttons per row" global setting
- Fixed status-dependent icons on menus not supporting comparison operators (e.g. `<25`) the way button icons already did
- Public-release cleanup: removed the legacy JS-adapter compatibility bridge and demo/example content, generic example registry, English README
- Fixed a compact-mode safety issue where event-trigger state was stored at module scope instead of per adapter instance

## 0.1.0

- Initial version: visual node editor, menu/button system, notification engine with permissions, and script bridge
